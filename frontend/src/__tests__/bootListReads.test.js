/**
 * The plan list and the DM list are asked for beside /api/auth/me at a cold
 * launch, instead of after /me answers and the signed-in tree mounts.
 *
 * Measured on the local stack: GET /api/flocks started about 440 ms after /me
 * did and was the last of eleven requests at mount, while the server answers
 * it in a few milliseconds. services/api.js primes both reads when /me goes
 * out; the two loaders take them once. This pins the handing out (once, fresh
 * enough, same token), the failure rules, the sign-out, and the one case where
 * the primed list must not be used: an invite redeemed at boot.
 */
import { primeBootReads, takeBootRead, dropBootReads, clearLocalSession } from '../services/api';

const fs = require('fs');
const path = require('path');

jest.mock('socket.io-client', () => ({ io: () => ({ on: () => {}, off: () => {}, emit: () => {}, connect: () => {}, disconnect: () => {}, removeAllListeners: () => {} }) }));

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function setOnline(value) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}
const urls = () => global.fetch.mock.calls.map(([u]) => String(u).replace(/^https?:\/\/[^/]+/, ''));

// The Nest's own reads, primed beside the two lists. Answered by default in
// every test here, so a read nobody scripted cannot fail into request()'s GET
// retries and land in the next test's fetch mock.
const NEST_READS = {
  '/api/users/stats': () => jsonRes({ streak: 0, friendCount: 0 }),
  '/api/friends/pending': () => jsonRes({ requests: [] }),
  '/api/availability/me': () => jsonRes({ pulse: null }),
  '/api/availability/friends': () => jsonRes({ friends: [] }),
  '/api/entitlements': () => jsonRes({}),
  '/api/users/profile': () => jsonRes({ user: {} }),
  '/api/blocks': () => jsonRes({ blocked: [] }),
  '/api/safety/contacts': () => jsonRes({ contacts: [] }),
};
const pathOf = (u) => String(u).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
// Answers by path, so the order the reads go out in does not matter.
function serve(routes) {
  const all = { ...NEST_READS, ...routes };
  global.fetch = jest.fn((url) => {
    const p = pathOf(url);
    const answer = all[p];
    if (!answer) return Promise.reject(new TypeError(`unscripted ${p}`));
    return Promise.resolve(typeof answer === 'function' ? answer() : answer);
  });
}

beforeEach(() => {
  localStorage.clear();
  setOnline(true);
  dropBootReads();
});

describe('primeBootReads and takeBootRead', () => {
  test('both lists go out at once with the stored token, and each is handed out once', async () => {
    localStorage.setItem('flockToken', 'tok-a');
    serve({ '/api/flocks': jsonRes({ flocks: [{ id: 3 }] }), '/api/dm': jsonRes({ conversations: [] }) });
    primeBootReads();
    expect(global.fetch.mock.calls.map(([u]) => pathOf(u)).sort()).toEqual(['/api/dm', '/api/flocks', ...Object.keys(NEST_READS)].sort());
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-a');

    await expect(takeBootRead('flocks')).resolves.toEqual({ flocks: [{ id: 3 }] });
    await expect(takeBootRead('dms')).resolves.toEqual({ conversations: [] });
    // Once each, and no second request was made for either.
    expect(takeBootRead('flocks')).toBeNull();
    expect(takeBootRead('dms')).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2 + Object.keys(NEST_READS).length);
  });

  test("the Nest's own reads are handed out once each", async () => {
    localStorage.setItem('flockToken', 'tok-a');
    serve({ '/api/flocks': jsonRes({ flocks: [] }), '/api/dm': jsonRes({ conversations: [] }) });
    primeBootReads();
    for (const key of ['userStats', 'pendingRequests', 'myAvailability', 'friendsAvailability', 'entitlements', 'profile', 'blocks', 'trustedContacts']) {
      const held = takeBootRead(key);
      expect(`${key} ${held === null ? 'missing' : 'held'}`).toBe(`${key} held`);
      await held;
      expect(takeBootRead(key)).toBeNull();
    }
  });

  test('/me goes out ahead of the primed reads', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
    const at = app.indexOf('const me = getCurrentUser();');
    expect(at).toBeGreaterThan(-1);
    expect(app.indexOf('primeBootReads();', at)).toBeGreaterThan(at);
    expect(app.slice(at, at + 120)).toMatch(/const me = getCurrentUser\(\);\s*primeBootReads\(\);\s*me\s*\.then/);
  });

  test('each Nest loader takes its read at its first call only', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
    for (const [key, fn] of [['trustedContacts', 'getTrustedContacts'], ['userStats', 'getUserStats'], ['pendingRequests', 'getPendingRequests'], ['myAvailability', 'getMyAvailability'], ['friendsAvailability', 'getFriendsAvailability'], ['entitlements', 'getEntitlements'], ['profile', 'getUserProfile'], ['blocks', 'getBlockedUsers']]) {
      expect(app.split(`(takeBootRead('${key}') || ${fn}())`).length - 1).toBe(1);
    }
  });

  test('no stored session, nothing is asked for and nothing is handed out', () => {
    serve({});
    primeBootReads();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(takeBootRead('flocks')).toBeNull();
  });

  test('a read taken after the window is not used', () => {
    localStorage.setItem('flockToken', 'tok-a');
    serve({ '/api/flocks': jsonRes({ flocks: [] }), '/api/dm': jsonRes({ conversations: [] }) });
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    primeBootReads();
    spy.mockReturnValue(now + 10001);
    expect(takeBootRead('flocks')).toBeNull();
    spy.mockRestore();
  });

  test('a read sent under another token is not used', () => {
    localStorage.setItem('flockToken', 'tok-a');
    serve({ '/api/flocks': jsonRes({ flocks: [] }), '/api/dm': jsonRes({ conversations: [] }) });
    primeBootReads();
    localStorage.setItem('flockToken', 'tok-b');
    expect(takeBootRead('flocks')).toBeNull();
  });

  test('sign-out drops what was held', () => {
    localStorage.setItem('flockToken', 'tok-a');
    serve({ '/api/flocks': jsonRes({ flocks: [] }), '/api/dm': jsonRes({ conversations: [] }) });
    primeBootReads();
    clearLocalSession();
    localStorage.setItem('flockToken', 'tok-a');
    expect(takeBootRead('flocks')).toBeNull();
    expect(takeBootRead('dms')).toBeNull();
  });

  test('a read that failed with no answer from the server is read again for the taker', async () => {
    localStorage.setItem('flockToken', 'tok-a');
    serve({ '/api/flocks': jsonRes({ flocks: [{ id: 9 }] }), '/api/dm': jsonRes({ conversations: [] }) });
    // Offline at launch: request() fails fast, before any fetch.
    setOnline(false);
    primeBootReads();
    expect(global.fetch).not.toHaveBeenCalled();
    // Back on signal by the time the list is wanted.
    setOnline(true);
    await expect(takeBootRead('flocks')).resolves.toEqual({ flocks: [{ id: 9 }] });
    expect(urls()).toEqual(['/api/flocks']);
  });

  test('a read the server refused is handed on as refused, not asked again', async () => {
    localStorage.setItem('flockToken', 'tok-a');
    serve({ '/api/flocks': jsonRes({ error: 'Nope' }, 500), '/api/dm': jsonRes({ conversations: [] }) });
    primeBootReads();
    await expect(takeBootRead('flocks')).rejects.toMatchObject({ status: 500 });
    expect(urls().filter((u) => u === '/api/flocks')).toHaveLength(1);
  });

  test('a primed read nobody takes does not surface as an unhandled rejection', async () => {
    localStorage.setItem('flockToken', 'tok-a');
    serve({ '/api/flocks': jsonRes({ error: 'Forbidden' }, 403), '/api/dm': jsonRes({ error: 'Forbidden' }, 403) });
    const seen = [];
    const onUnhandled = (e) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    primeBootReads();
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// App.js: where the reads are primed and taken
// ---------------------------------------------------------------------------
const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

function callbackFrom(source, marker) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  let i = source.indexOf('(', start);
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); continue; }
    if (ch === '/' && next === '*') { i = source.indexOf('*/', i + 2) + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, source.indexOf(';', i) + 1);
    }
    i += 1;
  }
  throw new Error('unterminated');
}

// loadFlocks, lifted and run against stand-ins for what it closes over.
function liftedLoadFlocks({ invite, primed }) {
  const state = { flocks: [], taken: 0, fresh: 0, opened: null, error: '', readAhead: null };
  // eslint-disable-next-line no-new-func
  const loadFlocks = new Function(
    'useCallback', 'setFlocksLoading', 'setFlocksError', 'redeemPendingInvite', 'takeBootRead', 'getFlocks',
    'formatEventTime', 'resolveVenuePhoto', 'setFlocks', 'setPendingFlockInvites', 'setDeclinedFlockInvites',
    'setVerifyPrompt', 'setVerifyNote', 'openJoinedFlock', 'prefetchUnreadRef',
    `${callbackFrom(app, 'const loadFlocks = useCallback(')}\nreturn loadFlocks;`,
  )(
    (fn) => fn, () => {}, (message) => { state.error = message; }, () => Promise.resolve(invite),
    () => { state.taken += 1; return primed ? Promise.resolve(primed) : null; },
    () => { state.fresh += 1; return Promise.resolve({ flocks: [{ id: 2, member_status: 'accepted', status: 'planning' }] }); },
    () => '', () => null,
    (next) => { state.flocks = typeof next === 'function' ? next(state.flocks) : next; },
    () => {}, () => {}, () => {}, () => {}, (inv) => { state.opened = inv; },
    { current: (order) => { state.readAhead = order; } },
  );
  return { state, loadFlocks };
}

describe('the loaders take the primed reads', () => {
  const PRIMED = { flocks: [{ id: 1, member_status: 'accepted', status: 'planning' }] };

  test('no invite at boot: the primed plan list is drawn and no second read goes out', async () => {
    const { state, loadFlocks } = liftedLoadFlocks({ invite: null, primed: PRIMED });
    await loadFlocks();
    expect(state.taken).toBe(1);
    expect(state.fresh).toBe(0);
    expect(state.flocks.map((f) => f.id)).toEqual([1]);
    expect(state.error).toBe('');
    // And the list order goes on to the unread read-ahead
    // (unreadPlanReadAhead.test.js runs that side).
    expect(state.readAhead).toEqual([1]);
  });

  test('an invite redeemed at boot: the primed list is stale, so it is dropped and read again', async () => {
    const invite = { flockId: 2, flockName: 'Friday' };
    const { state, loadFlocks } = liftedLoadFlocks({ invite, primed: PRIMED });
    await loadFlocks();
    expect(state.taken).toBe(1);
    expect(state.fresh).toBe(1);
    expect(state.flocks.map((f) => f.id)).toEqual([2]);
    expect(state.opened).toBe(invite);
    expect(state.error).toBe('');
  });

  test('nothing primed: the loader reads as it always did', async () => {
    const { state, loadFlocks } = liftedLoadFlocks({ invite: null, primed: null });
    await loadFlocks();
    expect(state.fresh).toBe(1);
    expect(state.flocks.map((f) => f.id)).toEqual([2]);
  });

  test('the DM list takes its primed read first and falls back to a fresh one', () => {
    const load = callbackFrom(app, 'const loadDmConversations = useCallback(');
    expect(load).toMatch(/return \(takeBootRead\('dms'\) \|\| getDMConversations\(\)\)/);
  });

  test('the boot primes both reads right beside /api/auth/me, and only with a stored session', () => {
    const boot = app.slice(app.indexOf('    if (!isLoggedIn()) {\n      setAuthChecking(false);'), app.indexOf('.finally(() => setAuthChecking(false));'));
    expect(boot).toMatch(/const me = getCurrentUser\(\);\n\s*primeBootReads\(\);\n\s*me\n\s*\.then/);
    // The retry loop, which runs only after a failed boot, primes nothing.
    expect((boot.match(/primeBootReads\(\)/g) || []).length).toBe(1);
  });
});
