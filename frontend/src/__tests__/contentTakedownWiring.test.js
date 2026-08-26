/**
 * Live moderation takedowns, client side.
 *
 * WHAT THIS COVERS
 *   1. services/socket.js really registers 'content_removed' and
 *      'content_restored' THROUGH THE SUBSCRIPTION REGISTRY, so the listener
 *      survives the socket instance being replaced (token swap, fatal-auth
 *      teardown, session expiry). socket.io-client is mocked, so this is the
 *      real module under a fake transport, not a source scan.
 *   2. App.js's takedown reducers, extracted from source and evaluated. They
 *      are pure functions of state precisely so they can be exercised without
 *      mounting a 17k-line component that pulls in maplibre and a QR scanner.
 *   3. The cross-file invariant: every content type
 *      backend/routes/admin.js can emit a takedown for is accounted for in
 *      App.js. This repo has shipped "a route widened a set of values and the
 *      thing behind it did not" three separate times (migrations 003, 016 and
 *      017 each fix an instance), and a takedown type the client silently
 *      ignores is that same bug.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 * It is the first test file in frontend/, so that command goes from "no tests
 * found" to running this.
 */

const fs = require('fs');
const path = require('path');

// ───────────────────────────────────────────────────────────────────────────
// A fake socket.io-client. Every io() call records a new instance and every
// .on() lands in a map we can inspect, which is how "did the registry re-apply
// the subscription to the NEW instance?" becomes an assertion.
// ───────────────────────────────────────────────────────────────────────────
// NOTE: plain functions, not jest.fn(). react-scripts sets resetMocks: true,
// which strips the implementation off every jest mock function before each
// test — a jest.fn() factory here returns undefined from the second test on.
jest.mock('socket.io-client', () => {
  const instances = [];
  const io = () => {
    const handlers = new Map();
    const instance = {
      connected: false,
      active: false,
      handlers,
      on: (event, cb) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(cb);
      },
      off: (event, cb) => {
        const bucket = handlers.get(event);
        if (bucket) bucket.delete(cb);
      },
      emit: () => {},
      connect: () => {},
      disconnect: () => {},
      removeAllListeners: () => handlers.clear(),
      // Deliver an event the way the server would.
      fire: (event, payload) => {
        (handlers.get(event) || new Set()).forEach((cb) => cb(payload));
      },
    };
    instances.push(instance);
    return instance;
  };
  return { io, __instances: instances };
});

const socketIoClient = require('socket.io-client');
const {
  connectSocket,
  disconnectSocket,
  onContentRemoved,
  onContentRestored,
} = require('../services/socket');

const instances = socketIoClient.__instances;
const has = (instance, event, cb) => !!instance.handlers.get(event)?.has(cb);

// ───────────────────────────────────────────────────────────────────────────
// Source readers. App.js cannot be imported here (it is the whole app), so the
// pure reducers are lifted out of it by name and evaluated.
// ───────────────────────────────────────────────────────────────────────────
const APP_PATH = path.resolve(__dirname, '../App.js');
const VENUE_DASHBOARD_PATH = path.resolve(__dirname, '../screens/VenueDashboard.js');
const SOCKET_PATH = path.resolve(__dirname, '../services/socket.js');
const ADMIN_PATH = path.resolve(__dirname, '../../../backend/routes/admin.js');

// Normalised to LF: these files are CRLF on disk, and a multi-line assertion
// written with \n would pass on a checkout with one convention and fail on the
// other, which is a test failure that says nothing about the code.
const readSource = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// The venue owner dashboard left App.js on 2026-08-26: it is its own lazily
// loaded chunk now (screens/VenueDashboard.js), and about 2,000 lines of what
// this file scans went with it. Nothing asserted below changed. The app source
// is simply in two files, so both are read, in the order they used to be one.
const appSource = readSource(APP_PATH) + readSource(VENUE_DASHBOARD_PATH);
const socketSource = readSource(SOCKET_PATH);
const adminSource = readSource(ADMIN_PATH);

/**
 * Pull `const <name> = …;` out of a source file, from a module-scope
 * declaration (column 0) to the semicolon that closes it. Strings, template
 * literals and both comment styles are skipped so a `;` or a brace inside one
 * cannot end the scan early — the reducers below carry long prose comments
 * with apostrophes and braces in them.
 */
function extractDeclaration(source, name) {
  const start = source.search(new RegExp(`^const ${name} = `, 'm'));
  if (start === -1) throw new Error(`extractDeclaration: no module-scope \`const ${name} =\` in source`);
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`extractDeclaration: unterminated declaration for ${name}`);
}

const REDUCER_NAMES = [
  'isModerationHidden',
  'sameContentId',
  'TAKEDOWN_HANDLED',
  'applyTakedownToFlocks',
  'applyTakedownToDms',
  'setModerationHidden',
  'dropContentById',
];

const reducers = (() => {
  const chunk = REDUCER_NAMES.map((n) => extractDeclaration(appSource, n)).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${chunk}\nreturn { ${REDUCER_NAMES.join(', ')} };`)();
})();

const {
  isModerationHidden,
  TAKEDOWN_HANDLED,
  applyTakedownToFlocks,
  applyTakedownToDms,
  setModerationHidden,
  dropContentById,
} = reducers;

// ───────────────────────────────────────────────────────────────────────────
// 1. socket.js — the subscription registry
// ───────────────────────────────────────────────────────────────────────────
describe('socket.js takedown subscriptions', () => {
  beforeEach(() => {
    localStorage.clear();
    disconnectSocket();
    instances.length = 0;
  });

  afterEach(() => {
    disconnectSocket();
  });

  test('a subscription made BEFORE any connection is applied to the first instance', () => {
    const cb = jest.fn();
    const off = onContentRemoved(cb);

    localStorage.setItem('flockToken', 'token-a');
    connectSocket();

    expect(instances).toHaveLength(1);
    expect(has(instances[0], 'content_removed', cb)).toBe(true);
    off();
  });

  test('the subscription survives a token swap onto a brand-new socket instance', () => {
    const removed = jest.fn();
    const restored = jest.fn();
    const offRemoved = onContentRemoved(removed);
    const offRestored = onContentRestored(restored);

    localStorage.setItem('flockToken', 'token-a');
    connectSocket();
    // Account switch: connectSocket disposes the old instance and builds a new
    // one. A listener welded to getSocket() would live and die on instances[0].
    localStorage.setItem('flockToken', 'token-b');
    connectSocket();

    expect(instances).toHaveLength(2);
    expect(has(instances[1], 'content_removed', removed)).toBe(true);
    expect(has(instances[1], 'content_restored', restored)).toBe(true);

    instances[1].fire('content_removed', { contentType: 'dm', contentId: 7, flockId: null });
    expect(removed).toHaveBeenCalledWith({ contentType: 'dm', contentId: 7, flockId: null });

    offRemoved();
    offRestored();
  });

  test('the subscription survives a full teardown (session expiry) and reconnect', () => {
    const cb = jest.fn();
    const off = onContentRemoved(cb);

    localStorage.setItem('flockToken', 'token-a');
    connectSocket();
    disconnectSocket(); // what the 'flock-session-expired' handler does
    localStorage.setItem('flockToken', 'token-c');
    connectSocket();

    const latest = instances[instances.length - 1];
    expect(has(latest, 'content_removed', cb)).toBe(true);
    off();
  });

  test('unsubscribing stops the callback reaching any later instance', () => {
    const cb = jest.fn();
    const off = onContentRemoved(cb);
    localStorage.setItem('flockToken', 'token-a');
    connectSocket();
    off();

    localStorage.setItem('flockToken', 'token-d');
    connectSocket();

    const latest = instances[instances.length - 1];
    expect(has(latest, 'content_removed', cb)).toBe(false);
  });

  test('both takedown events go through register(), never a raw socket.on', () => {
    const body = socketSource.slice(socketSource.indexOf('export function onContentRemoved'));
    expect(body).toMatch(/export function onContentRemoved\(callback\) \{\s*return register\('content_removed', callback\);/);
    expect(body).toMatch(/export function onContentRestored\(callback\) \{\s*return register\('content_restored', callback\);/);
    // Nothing in the module may bind these to an instance directly.
    expect(socketSource).not.toMatch(/socket\.on\(\s*['"]content_(removed|restored)['"]/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The reducers
// ───────────────────────────────────────────────────────────────────────────
describe('applyTakedownToFlocks', () => {
  const flocks = () => ([
    { id: 1, memberCount: 3, messages: [{ id: 10, text: 'hi' }, { id: 11, text: 'bye' }], guests: [] },
    {
      id: 2,
      memberCount: 4,
      messages: [{ id: 20, text: 'other flock' }],
      guests: [
        { id: 'guest:5', guestId: 5, name: 'Sam', status: 'accepted', isGuest: true },
        { id: 'guest:6', guestId: 6, name: 'Rae', status: 'declined', isGuest: true },
      ],
    },
  ]);

  test('drops the taken-down message and leaves every other flock by reference', () => {
    const before = flocks();
    const after = applyTakedownToFlocks(before, { contentType: 'flock_message', contentId: 11, flockId: 1 });
    expect(after[0].messages.map((m) => m.id)).toEqual([10]);
    expect(after[1]).toBe(before[1]);
    expect(after).not.toBe(before);
  });

  test('matches a numeric content id against a numeric message id across the string boundary', () => {
    const after = applyTakedownToFlocks(flocks(), { contentType: 'flock_message', contentId: '11', flockId: '1' });
    expect(after[0].messages.map((m) => m.id)).toEqual([10]);
  });

  test('returns the SAME array when nothing matched, so React bails out', () => {
    const before = flocks();
    expect(applyTakedownToFlocks(before, { contentType: 'flock_message', contentId: 999, flockId: 1 })).toBe(before);
  });

  test('honours the flockId scope: a message id in another flock is untouched', () => {
    const before = flocks();
    const after = applyTakedownToFlocks(before, { contentType: 'flock_message', contentId: 20, flockId: 1 });
    expect(after).toBe(before);
  });

  test('an unsent optimistic bubble is never mistaken for the taken-down row', () => {
    const before = [{ id: 1, memberCount: 1, messages: [{ id: 'temp-11', text: 'sending' }], guests: [] }];
    expect(applyTakedownToFlocks(before, { contentType: 'flock_message', contentId: 11, flockId: 1 })).toBe(before);
  });

  test('drops a guest by its plain row id and takes the going count down with it', () => {
    const before = flocks();
    const after = applyTakedownToFlocks(before, { contentType: 'guest_rsvp', contentId: 5, flockId: 2 });
    expect(after[1].guests.map((g) => g.guestId)).toEqual([6]);
    expect(after[1].memberCount).toBe(3);
    expect(after[0]).toBe(before[0]);
  });

  test('removing a guest who had declined does not move the going count', () => {
    const after = applyTakedownToFlocks(flocks(), { contentType: 'guest_rsvp', contentId: 6, flockId: 2 });
    expect(after[1].guests.map((g) => g.guestId)).toEqual([5]);
    expect(after[1].memberCount).toBe(4);
  });

  test('the going count never goes negative', () => {
    const before = [{
      id: 3, memberCount: 0, messages: [],
      guests: [{ id: 'guest:9', guestId: 9, status: 'accepted' }],
    }];
    const after = applyTakedownToFlocks(before, { contentType: 'guest_rsvp', contentId: 9, flockId: 3 });
    expect(after[0].memberCount).toBe(0);
  });

  test('the namespaced roster id is not treated as the content id', () => {
    // content_id is the guest_rsvps row id (5), never the "guest:5" string.
    const before = flocks();
    expect(applyTakedownToFlocks(before, { contentType: 'guest_rsvp', contentId: 'guest:5', flockId: 2 })).toBe(before);
  });

  test('ignores content types that do not live in the flock list', () => {
    const before = flocks();
    for (const contentType of ['dm', 'story', 'venue_review', 'venue_promotion', 'venue_event']) {
      // A message id…
      expect(applyTakedownToFlocks(before, { contentType, contentId: 10, flockId: 1 })).toBe(before);
      // …and a guest id. Separate tables share an id space, so a venue_review
      // with id 5 must not be able to evict the guest whose row id is 5. The
      // type guard is the only thing standing between those two.
      expect(applyTakedownToFlocks(before, { contentType, contentId: 5, flockId: 2 })).toBe(before);
    }
  });

  test('a missing content id is a no-op rather than a mass deletion', () => {
    const before = flocks();
    expect(applyTakedownToFlocks(before, { contentType: 'flock_message', contentId: null, flockId: 1 })).toBe(before);
    expect(applyTakedownToFlocks(before, { contentType: 'guest_rsvp', contentId: undefined, flockId: 2 })).toBe(before);
  });

  test('survives flocks with no messages or guests arrays at all', () => {
    const before = [{ id: 1, memberCount: 1 }];
    expect(applyTakedownToFlocks(before, { contentType: 'flock_message', contentId: 1, flockId: 1 })).toBe(before);
    expect(applyTakedownToFlocks(before, { contentType: 'guest_rsvp', contentId: 1, flockId: 1 })).toBe(before);
  });
});

describe('applyTakedownToDms', () => {
  const convos = () => ([
    {
      userId: 7,
      messages: [{ id: 100, text: 'first' }, { id: 101, text: 'harassment' }],
      lastMessage: 'harassment',
      lastMessageTime: '2026-08-14T10:00:00Z',
      lastMessageIsYou: false,
      unread: 1,
    },
    { userId: 8, messages: [], lastMessage: 'never opened', lastMessageTime: '2026-08-13T10:00:00Z', lastMessageIsYou: true, unread: 0 },
  ]);

  test('drops the taken-down message and leaves other conversations by reference', () => {
    const before = convos();
    const after = applyTakedownToDms(before, { contentType: 'dm', contentId: 101 });
    expect(after[0].messages.map((m) => m.id)).toEqual([100]);
    expect(after[1]).toBe(before[1]);
  });

  test('leaves the stored preview alone while a loaded message remains', () => {
    // The inbox row derives its preview from the last LOADED message whenever
    // there is one, so it corrects itself and the stored fields are unread.
    const after = applyTakedownToDms(convos(), { contentType: 'dm', contentId: 101 });
    expect(after[0].lastMessageTime).toBe('2026-08-14T10:00:00Z');
  });

  test('clears the stored preview when the takedown empties the thread', () => {
    const before = [{
      userId: 9,
      messages: [{ id: 200, text: 'the only one' }],
      lastMessage: 'the only one',
      lastMessageTime: '2026-08-14T11:00:00Z',
      lastMessageIsYou: false,
      unread: 1,
    }];
    const after = applyTakedownToDms(before, { contentType: 'dm', contentId: 200 });
    expect(after[0].messages).toEqual([]);
    expect(after[0].lastMessage).toBe('');
    expect(after[0].lastMessageTime).toBe(null);
    expect(after[0].lastMessageIsYou).toBe(false);
  });

  test('returns the SAME array when nothing matched', () => {
    const before = convos();
    expect(applyTakedownToDms(before, { contentType: 'dm', contentId: 999 })).toBe(before);
  });

  test('matches across the string/number boundary, on the bubble and on the quote', () => {
    const before = [{
      userId: 7,
      messages: [
        { id: 100, text: 'harassment' },
        { id: 101, text: 'stop', reply_to: { id: 100, text: 'harassment', sender: 'Kai' } },
      ],
      lastMessage: 'stop', lastMessageTime: null, lastMessageIsYou: true, unread: 0,
    }];
    const after = applyTakedownToDms(before, { contentType: 'dm', contentId: '100' });
    expect(after[0].messages.map((m) => m.id)).toEqual([101]);
    expect(after[0].messages[0].reply_to).toBe(null);
  });

  test('a never-opened conversation is left completely alone', () => {
    const before = convos();
    const after = applyTakedownToDms(before, { contentType: 'dm', contentId: 101 });
    expect(after[1].lastMessage).toBe('never opened');
  });

  test('ignores every non-dm content type', () => {
    const before = convos();
    for (const contentType of ['flock_message', 'guest_rsvp', 'story', 'venue_review']) {
      expect(applyTakedownToDms(before, { contentType, contentId: 101 })).toBe(before);
    }
  });

  test('a missing content id is a no-op', () => {
    const before = convos();
    expect(applyTakedownToDms(before, { contentType: 'dm', contentId: null })).toBe(before);
  });

  // A reply carries a verbatim copy of the body it quotes, rendered above the
  // bubble. Dropping the original and leaving the quote leaves the exact words
  // on screen, which is the one thing the takedown is for.
  test('strips the quote out of every reply to the taken-down message', () => {
    const before = [{
      userId: 7,
      messages: [
        { id: 100, text: 'harassment' },
        { id: 101, text: 'stop', reply_to: { id: 100, text: 'harassment', sender: 'Kai' } },
        { id: 102, text: 'unrelated', reply_to: { id: 99, text: 'something else', sender: 'Kai' } },
      ],
      lastMessage: 'unrelated',
      lastMessageTime: '2026-08-14T12:00:00Z',
      lastMessageIsYou: false,
      unread: 0,
    }];
    const after = applyTakedownToDms(before, { contentType: 'dm', contentId: 100 });
    expect(after[0].messages.map((m) => m.id)).toEqual([101, 102]);
    expect(after[0].messages[0].reply_to).toBe(null);
    // A quote of a DIFFERENT message is left exactly as it was.
    expect(after[0].messages[1].reply_to).toEqual({ id: 99, text: 'something else', sender: 'Kai' });
  });

  test('strips the quote even when the quoted original was never loaded', () => {
    // Scrolled-off history: the reply is on screen, its parent is not. The
    // quote is still a full copy of the removed body.
    const before = [{
      userId: 7,
      messages: [{ id: 101, text: 'stop', reply_to: { id: 100, text: 'harassment', sender: 'Kai' } }],
      lastMessage: 'stop',
      lastMessageTime: '2026-08-14T12:00:00Z',
      lastMessageIsYou: true,
      unread: 0,
    }];
    const after = applyTakedownToDms(before, { contentType: 'dm', contentId: 100 });
    expect(after).not.toBe(before);
    expect(after[0].messages).toHaveLength(1);
    expect(after[0].messages[0].reply_to).toBe(null);
    // Nothing was dropped, so the inbox preview must NOT be cleared.
    expect(after[0].lastMessage).toBe('stop');
  });

  test('a conversation holding neither the message nor a quote of it is untouched', () => {
    const before = [{
      userId: 8,
      messages: [{ id: 200, text: 'hi', reply_to: { id: 199, text: 'hey', sender: 'Ro' } }],
      lastMessage: 'hi',
      lastMessageTime: null,
      lastMessageIsYou: false,
      unread: 0,
    }];
    expect(applyTakedownToDms(before, { contentType: 'dm', contentId: 100 })).toBe(before);
  });
});

describe('setModerationHidden', () => {
  const rows = () => ([
    { id: 1, title: 'Happy hour' },
    { id: 2, title: 'Late night', hidden_by_moderation: true },
  ]);

  test('marks the named row and leaves the rest by reference', () => {
    const before = rows();
    const after = setModerationHidden(before, 1, true);
    expect(isModerationHidden(after[0])).toBe(true);
    expect(after[1]).toBe(before[1]);
  });

  test('marking an already-hidden row returns the SAME array', () => {
    const before = rows();
    expect(setModerationHidden(before, 2, true)).toBe(before);
  });

  test('a restore clears BOTH spellings, so isModerationHidden goes false', () => {
    // A row can carry hidden_by_moderation (list read) or raw is_hidden (write
    // response), and isModerationHidden ORs them. Clearing one is not a restore.
    const before = [{ id: 3, is_hidden: true, hidden_by_moderation: true }];
    const after = setModerationHidden(before, 3, false);
    expect(isModerationHidden(after[0])).toBe(false);
    expect(after[0].is_hidden).toBe(false);
    expect(after[0].hidden_by_moderation).toBe(false);
  });

  test('a restore of a row that arrived with only the raw column still clears', () => {
    const before = [{ id: 4, is_hidden: true }];
    const after = setModerationHidden(before, 4, false);
    expect(isModerationHidden(after[0])).toBe(false);
  });

  test('restoring a row that was never hidden returns the SAME array', () => {
    const before = rows();
    expect(setModerationHidden(before, 1, false)).toBe(before);
  });

  test('an unmatched or missing id is a no-op', () => {
    const before = rows();
    expect(setModerationHidden(before, 999, true)).toBe(before);
    expect(setModerationHidden(before, null, true)).toBe(before);
  });
});

describe('dropContentById', () => {
  test('removes the row and returns the SAME array when nothing matched', () => {
    const before = [{ id: 1 }, { id: 2 }];
    expect(dropContentById(before, 2).map((r) => r.id)).toEqual([1]);
    expect(dropContentById(before, 99)).toBe(before);
    expect(dropContentById(before, null)).toBe(before);
  });

  test('matches across the string/number boundary', () => {
    const before = [{ id: 42 }];
    expect(dropContentById(before, '42')).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Client and server agree on what a takedown is
// ───────────────────────────────────────────────────────────────────────────
describe('the client is in step with routes/admin.js', () => {
  const serverTypes = (() => {
    const start = adminSource.indexOf('const TAKEDOWN_TARGETS = {');
    expect(start).toBeGreaterThan(-1);
    const end = adminSource.indexOf('\n};', start);
    expect(end).toBeGreaterThan(start);
    const block = adminSource.slice(start, end);
    return [...block.matchAll(/^ {2}([a-z_]+): \{/gm)].map((m) => m[1]);
  })();

  test('the server really does define takedown targets', () => {
    expect(serverTypes.length).toBeGreaterThanOrEqual(7);
    expect(serverTypes).toEqual(expect.arrayContaining(['flock_message', 'dm', 'story', 'guest_rsvp']));
  });

  test('every content type the server can emit for is accounted for in App.js', () => {
    expect([...serverTypes].sort()).toEqual(Object.keys(TAKEDOWN_HANDLED).sort());
  });

  test('the server emits exactly the two event names socket.js registers', () => {
    expect(adminSource).toContain("actionType === 'content_hidden' ? 'content_removed' : 'content_restored'");
    expect(socketSource).toContain("register('content_removed', callback)");
    expect(socketSource).toContain("register('content_restored', callback)");
  });

  test('App.js reads the payload fields the server actually sends', () => {
    // { contentType, contentId, flockId } — nothing else is on the wire.
    const payload = adminSource.slice(adminSource.indexOf('const payload = {'), adminSource.indexOf('const already'));
    expect(payload).toContain('contentType: report.content_type');
    expect(payload).toContain('contentId: report.content_id');
    expect(payload).toContain('flockId: audience.flockId');
    expect(appSource).toContain('contentType: data?.contentType');
    expect(appSource).toContain('contentId: data?.contentId');
    expect(appSource).toContain('flockId: data?.flockId ?? null');
  });

  test('App.js subscribes through the registry helpers, not through getSocket()', () => {
    expect(appSource).toContain('onContentRemoved((data) => applyRemoval(data, true))');
    expect(appSource).toContain('onContentRestored((data) => applyRemoval(data, false))');
    expect(appSource).not.toMatch(/getSocket\(\)[?.]*\.on\(\s*['"]content_/);
  });

  test('the open composers that quote or edit the content are cleared with it', () => {
    // The reply bar quotes the message body under "Replying to …", so a
    // takedown that leaves it open leaves the removed words on screen. Scoped
    // per type: messages.id and direct_messages.id are separate sequences.
    expect(appSource).toContain(
      "setReplyingTo(prev => (prev && sameContentId(prev.id, ev.contentId) ? null : prev))"
    );
    expect(appSource).toContain(
      'setDmReplyingTo(prev => (prev && sameContentId(prev.id, ev.contentId) ? null : prev))'
    );
    expect(appSource).toMatch(/if \(ev\.contentType === 'flock_message'\) \{\n\s+setReplyingTo\(/);
    // A promotion/event composer open on a row that was just taken down can
    // only ever answer 409 on Save.
    expect(appSource).toContain('if (hidden && editingPromo && sameContentId(editingPromo.id, ev.contentId)) {');
    expect(appSource).toContain('if (hidden && editingEvent && sameContentId(editingEvent.id, ev.contentId)) {');
    // Which is only readable because the effect re-subscribes on those.
    expect(appSource).toContain('}, [editingPromo, editingEvent]);');
  });

  test('every type App.js claims to handle has a branch, and the unhandled one does not', () => {
    for (const [type, target] of Object.entries(TAKEDOWN_HANDLED)) {
      if (target === 'none') {
        expect(appSource).not.toContain(`case '${type}':`);
      } else {
        expect(appSource).toContain(`case '${type}':`);
      }
    }
  });

  test('stories are the only type marked unhandled, and only while there is no story UI', () => {
    expect(TAKEDOWN_HANDLED.story).toBe('none');
    expect(Object.values(TAKEDOWN_HANDLED).filter((v) => v === 'none')).toHaveLength(1);
    // The claim behind that 'none': this client renders no stories at all.
    expect(appSource).not.toMatch(/\bgetStories\b/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The venue dashboard's swallowed reads
// ───────────────────────────────────────────────────────────────────────────
describe('venue dashboard list reads', () => {
  test('neither incoming flocks nor reviews swallows a failure into an empty list', () => {
    expect(appSource).not.toContain('getIncomingFlocks().catch(');
    expect(appSource).not.toContain('getVenueReviews().catch(');
  });

  test('both load through a shared reader that raises a per-list error flag', () => {
    for (const name of ['loadIncomingFlocks', 'loadVenueReviews']) {
      expect(appSource).toMatch(new RegExp(`const ${name} = React\\.useCallback`));
    }
    expect(appSource).toMatch(/setVenueListErrors\(prev => \(prev\.reviews \? prev : \{ \.\.\.prev, reviews: true \}\)\)/);
  });

  test('an incoming-flocks refusal is told apart from an incoming-flocks failure', () => {
    expect(appSource).toContain("const locked = err?.code === 'UPGRADE_REQUIRED';");
    expect(appSource).toContain('incomingFlocksLocked');
    // The refusal must NOT offer a retry that can only refuse again.
    const banner = appSource.slice(
      appSource.indexOf('{venueListErrors.incomingFlocksLocked && ('),
      appSource.indexOf('{incomingFlocks.length > 0 ?')
    );
    expect(banner).toContain('See plans');
    expect(banner).not.toContain('Try again');
  });

  test('the failure banners render above their lists, never instead of them', () => {
    // The list body must still be reachable after the banner, i.e. the banner
    // is a sibling and not a branch that replaces the rows that did load.
    const incoming = appSource.indexOf('{venueListErrors.incomingFlocks && (');
    const incomingRows = appSource.indexOf('{incomingFlocks.length > 0 ?');
    expect(incoming).toBeGreaterThan(-1);
    expect(incomingRows).toBeGreaterThan(incoming);

    const reviewsBanner = appSource.indexOf('{venueListErrors.reviews && (');
    const reviewsRows = appSource.indexOf('{reviews.length > 0 && (');
    expect(reviewsBanner).toBeGreaterThan(-1);
    expect(reviewsRows).toBeGreaterThan(reviewsBanner);
  });

  test('the confident empty states are suppressed when the read never landed', () => {
    expect(appSource).toMatch(/\(venueListErrors\.incomingFlocks \|\| venueListErrors\.incomingFlocksLocked\) \? null : \(/);
    expect(appSource).toContain('venueListErrors.reviews ? (');
  });

  test('a failed profile read names every list flag, not just the two it used to', () => {
    const reset = appSource.slice(
      appSource.indexOf('setVenueListErrors({\n          promotions: true'),
      appSource.indexOf('setVenueListErrors({\n          promotions: true') + 220
    );
    for (const key of ['promotions', 'events', 'reviews', 'incomingFlocks', 'incomingFlocksLocked']) {
      expect(reset).toContain(`${key}:`);
    }
  });

  test('the analytics tile stops printing a confident zero for a read that failed', () => {
    expect(appSource).toContain(
      "{(venueListErrors.incomingFlocks || venueListErrors.incomingFlocksLocked) ? '–' : realIncomingFlocks.length}"
    );
  });
});
