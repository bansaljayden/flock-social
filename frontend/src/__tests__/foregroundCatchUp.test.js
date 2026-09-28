/**
 * Coming back to the app with the socket gone.
 *
 * socket.js lets the connection go the moment the native app is hidden (after
 * a grace period on the web). Whatever was said in the open chat meanwhile
 * never arrived live, and the only thing that brought it in was the reconnect
 * sampler, up to two seconds after the handshake, after which the twelve
 * second minimum gap held the read back whenever the chat had been opened just
 * before leaving. Measured: the reply a push announced appeared a median 1.9 s
 * after the return, and 5 to 7 s in that case, for a read that takes under
 * 200 ms. And because the sampler compares consecutive samples, a drop it never
 * ticked through (iOS suspends timers in the background) ran no catch-up at
 * all.
 *
 * This pins, by running the lifted code:
 *   1. the return with a dead socket reads the open conversation at once, gap
 *      skipped, and cancels a read the gap had deferred;
 *   2. the return with a live socket reads nothing new;
 *   3. the lists are read on that return too, and the reconnect that
 *      follows defers its own read of them to the end of the same minimum
 *      gap the conversation keeps, rather than reading the pair twice;
 *   4. a drop is heard through socket.js's registry, so the next sample after
 *      the socket comes back is a reconnect even if no sample saw it down.
 */
const fs = require('fs');
const path = require('path');

// A fake socket.io-client, the same shape contentTakedownWiring uses, so the
// real socket.js runs against it. Plain functions, not jest.fn(): react-scripts
// resets mocks between tests.
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
const { connectSocket, disconnectSocket, onSocketDisconnect } = require('../services/socket');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

// From an opener (`useEffect(` or `useCallback(`) to the `);` that closes it,
// skipping strings and comments so a paren inside prose cannot end the scan.
function statementFrom(source, start) {
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
  throw new Error('statementFrom: unterminated');
}
// The effect that contains `needle`.
function effectAround(needle) {
  const at = app.indexOf(needle);
  expect(at).toBeGreaterThan(-1);
  return statementFrom(app, app.lastIndexOf('useEffect(', at));
}
function run(src, scope) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(scope), src)(...Object.values(scope));
}
// A module-scope `const <name> = ...;`, from its `=` to the `;` that ends it
// at depth zero, skipping strings and comments.
function moduleConst(name) {
  const start = app.search(new RegExp(`^const ${name} = `, 'm'));
  expect(start).toBeGreaterThan(-1);
  let i = app.indexOf('=', start) + 1;
  let depth = 0;
  while (i < app.length) {
    const ch = app[i];
    const next = app[i + 1];
    if (ch === '/' && next === '/') { i = app.indexOf('\n', i); continue; }
    if (ch === '/' && next === '*') { i = app.indexOf('*/', i + 2) + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < app.length && app[i] !== quote) i += app[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return app.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`moduleConst: ${name} unterminated`);
}
// What runCatchUp hands a loader as `anchor`: the rows on screen before the
// socket dropped (chatEchoOrderAndRetraction.test.js pins that measure). No
// sampler runs in these conversations, so there is no snapshot, and the
// anchor is the empty set heldBeforeDrop answers with.
const heldBeforeDrop = (() => {
  const names = ['SERVER_ID_MAX', 'isServerId', 'heldServerIds', 'heldBeforeDrop'];
  // eslint-disable-next-line no-new-func
  return new Function(`${names.map(moduleConst).join('\n')}\nreturn heldBeforeDrop;`)();
})();
const NO_SNAPSHOT = new Set();
// A document stand-in the lifted code sees instead of jsdom's.
function fakeDocument(state = 'visible') {
  const listeners = new Set();
  return {
    visibilityState: state,
    addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.delete(fn); },
    show() { this.visibilityState = 'visible'; listeners.forEach((fn) => fn()); },
    hide() { this.visibilityState = 'hidden'; listeners.forEach((fn) => fn()); },
    listeners,
  };
}
const CATCHUP_MIN_GAP_MS = 12000;

// ---------------------------------------------------------------------------
// runCatchUp and the conversation's return handler, lifted and run
// ---------------------------------------------------------------------------
function conversation({ readAgoMs, screen = 'chatDetail', socketConnected = false, doc = fakeDocument() }) {
  const reads = [];
  const timers = new Map();
  let nextTimer = 1;
  const historyReadAtRef = { current: { 'flock:7': Date.now() - readAgoMs, 'dm:5': Date.now() - readAgoMs } };
  const scope = {
    useCallback: (fn) => fn,
    document: doc,
    catchUpPendingRef: { current: false },
    catchUpTargetRef: { current: { screen, flockId: 7, dmId: 5 } },
    CATCHUP_MIN_GAP_MS,
    historyReadAtRef,
    catchUpTimerRef: { current: null },
    runCatchUpRef: { current: null },
    heldWhileUpRef: { current: null },
    catchUpOwedRef: { current: false },
    heldBeforeDrop,
    loadFlockMessages: (id, opts) => reads.push(['messages', id, opts]),
    loadMoneyState: (id) => reads.push(['money', id]),
    loadFlockVotes: (id) => reads.push(['votes', id]),
    refreshFlockRoster: (id) => reads.push(['roster', id]),
    loadDmMessages: (id, opts) => reads.push(['dm', id, opts]),
    setTimeout: (fn, ms) => { const t = nextTimer++; timers.set(t, { fn, ms }); return t; },
    clearTimeout: (t) => timers.delete(t),
  };
  const runCatchUp = run(`${statementFrom(app, app.indexOf('const runCatchUp = useCallback('))}\nreturn runCatchUp;`, scope);
  scope.runCatchUpRef.current = runCatchUp;
  const calls = [];
  const spy = (opts) => { calls.push(opts); return runCatchUp(opts); };
  let cleanup = null;
  run(effectAround('if (!getSocket()?.connected) runCatchUp({ force: true });'), {
    useEffect: (fn) => { cleanup = fn(); },
    document: doc,
    getSocket: () => ({ connected: socketConnected }),
    runCatchUp: spy,
    catchUpPendingRef: scope.catchUpPendingRef,
    catchUpTimerRef: scope.catchUpTimerRef,
    clearTimeout: scope.clearTimeout,
  });
  return { reads, timers, scope, runCatchUp, calls, doc, cleanup: () => cleanup && cleanup() };
}

describe('the open conversation on the return', () => {
  test('a read inside the gap is deferred on a reconnect, as before', () => {
    const c = conversation({ readAgoMs: 2000 });
    c.runCatchUp();
    expect(c.reads).toEqual([]);
    expect(c.timers.size).toBe(1);
    const [{ ms }] = [...c.timers.values()];
    expect(ms).toBeGreaterThan(9000);
    expect(ms).toBeLessThanOrEqual(10000);
  });

  test('forced, it reads now, and the deferred read it makes redundant is cancelled', () => {
    const c = conversation({ readAgoMs: 2000 });
    c.runCatchUp();
    expect(c.timers.size).toBe(1);
    c.runCatchUp({ force: true });
    expect(c.reads.map((r) => r[0])).toEqual(['messages', 'money', 'votes', 'roster']);
    expect(c.reads[0]).toEqual(['messages', 7, { keepOlder: true, anchor: NO_SNAPSHOT }]);
    expect(c.timers.size).toBe(0);
  });

  test('forced while hidden, it still waits for someone to look', () => {
    const c = conversation({ readAgoMs: 2000, doc: fakeDocument('hidden') });
    c.runCatchUp({ force: true });
    expect(c.reads).toEqual([]);
    expect(c.scope.catchUpPendingRef.current).toBe(true);
  });

  test('coming back with the socket gone reads the open chat at once, gap or no gap', () => {
    const c = conversation({ readAgoMs: 2000, doc: fakeDocument('hidden') });
    c.doc.show();
    expect(c.calls).toEqual([{ force: true }]);
    expect(c.reads[0]).toEqual(['messages', 7, { keepOlder: true, anchor: NO_SNAPSHOT }]);
  });

  test('a DM thread is read the same way', () => {
    const c = conversation({ readAgoMs: 1000, screen: 'dmDetail', doc: fakeDocument('hidden') });
    c.doc.show();
    expect(c.reads).toEqual([['dm', 5, { keepOlder: true, anchor: NO_SNAPSHOT }]]);
  });

  test('coming back with the socket still up reads nothing, since nothing was missed', () => {
    const c = conversation({ readAgoMs: 60000, socketConnected: true, doc: fakeDocument('hidden') });
    c.doc.show();
    expect(c.calls).toEqual([]);
    expect(c.reads).toEqual([]);
  });

  test('a live socket with a catch-up held while hidden flushes it, throttle intact', () => {
    const c = conversation({ readAgoMs: 60000, socketConnected: true, doc: fakeDocument('hidden') });
    c.scope.catchUpPendingRef.current = true;
    c.doc.show();
    expect(c.calls).toEqual([undefined]);
    expect(c.reads[0][0]).toBe('messages');
  });

  test('going hidden reads nothing', () => {
    const c = conversation({ readAgoMs: 60000 });
    c.doc.hide();
    expect(c.calls).toEqual([]);
  });

  test('no conversation open, nothing to read', () => {
    const c = conversation({ readAgoMs: 60000, screen: 'home', doc: fakeDocument('hidden') });
    c.doc.show();
    expect(c.reads).toEqual([]);
  });

  test('the listener comes off on unmount', () => {
    const c = conversation({ readAgoMs: 60000 });
    expect(c.doc.listeners.size).toBe(1);
    c.cleanup();
    expect(c.doc.listeners.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The lists on the return
// ---------------------------------------------------------------------------
// The list reader, its reconnect effect and its return handler, lifted and run
// against a clock and timers the test owns.
function lists({ socketConnected, pending = false }) {
  const doc = fakeDocument('hidden');
  const reads = [];
  const clock = { now: 1000000 };
  const timers = new Map();
  let nextTimer = 1;
  const socket = { connected: socketConnected };
  const scope = {
    useCallback: (fn) => fn,
    document: doc,
    Date: { now: () => clock.now },
    CATCHUP_MIN_GAP_MS,
    listsGapPendingRef: { current: pending },
    listsGapReadAtRef: { current: 0 },
    listsGapTimerRef: { current: null },
    readListsForGapRef: { current: null },
    loadFlocks: () => reads.push('flocks'),
    loadDmConversations: () => reads.push('dms'),
    setTimeout: (fn, ms) => { const t = nextTimer++; timers.set(t, { fn, ms, at: clock.now + ms }); return t; },
    clearTimeout: (t) => timers.delete(t),
  };
  const readListsForGap = run(`${statementFrom(app, app.indexOf('const readListsForGap = useCallback('))}\nreturn readListsForGap;`, scope);
  scope.readListsForGapRef.current = readListsForGap;
  const reconnectEffect = effectAround('if (reconnectTick) readListsForGap();');
  let ticks = 0;
  const tick = () => {
    ticks += 1;
    run(reconnectEffect, { useEffect: (fn) => fn(), reconnectTick: ticks, readListsForGap });
  };
  let cleanup = null;
  run(effectAround('if (!getSocket()?.connected) readListsForGap({ force: true });'), {
    useEffect: (fn) => { cleanup = fn(); },
    document: doc,
    getSocket: () => socket,
    readListsForGap,
    listsGapPendingRef: scope.listsGapPendingRef,
    listsGapTimerRef: scope.listsGapTimerRef,
    clearTimeout: scope.clearTimeout,
  });
  const advance = (ms) => { clock.now += ms; };
  // Fire whatever timer is due, moving the clock to it.
  const fireTimers = () => {
    [...timers.entries()].forEach(([t, { fn, at }]) => {
      timers.delete(t);
      if (at > clock.now) clock.now = at;
      fn();
    });
  };
  // Fire only the timers already due at the current time.
  const fireDue = () => {
    [...timers.entries()].forEach(([t, { fn, at }]) => {
      if (at > clock.now) return;
      timers.delete(t);
      fn();
    });
  };
  const pairs = () => reads.filter((r) => r === 'flocks').length;
  return { doc, reads, timers, socket, tick, advance, fireTimers, fireDue, pairs, listsGapPendingRef: scope.listsGapPendingRef, cleanup: () => cleanup && cleanup() };
}

describe('the plan and DM lists on the return', () => {
  test('read on a return with the socket gone', () => {
    const l = lists({ socketConnected: false });
    l.doc.show();
    expect(l.reads).toEqual(['flocks', 'dms']);
  });

  test('not read on a return with the socket up and nothing held', () => {
    const l = lists({ socketConnected: true });
    l.doc.show();
    expect(l.reads).toEqual([]);
  });

  test('a reconnect held while hidden is still flushed, and only once', () => {
    const l = lists({ socketConnected: true, pending: true });
    l.doc.show();
    l.doc.show();
    expect(l.reads).toEqual(['flocks', 'dms']);
    expect(l.listsGapPendingRef.current).toBe(false);
  });

  test('a first reconnect with no read behind it reads at once', () => {
    const l = lists({ socketConnected: true });
    l.doc.visibilityState = 'visible';
    l.tick();
    expect(l.reads).toEqual(['flocks', 'dms']);
    expect(l.timers.size).toBe(0);
  });

  test('the reconnect tick after the return defers its read to the end of the window instead of reading the pair again', () => {
    const l = lists({ socketConnected: false });
    l.doc.show();
    expect(l.pairs()).toBe(1);
    // The handshake lands and the sampler ticks a second and a half later.
    l.socket.connected = true;
    l.advance(1500);
    l.tick();
    expect(l.pairs()).toBe(1);
    expect(l.timers.size).toBe(1);
    const [{ ms }] = [...l.timers.values()];
    expect(ms).toBe(CATCHUP_MIN_GAP_MS - 1500);
    // Deferred, not dropped: the handshake window is still read once.
    l.fireTimers();
    expect(l.pairs()).toBe(2);
    expect(l.timers.size).toBe(0);
  });

  test('switching apps every few seconds costs one pair per return, not two', () => {
    const l = lists({ socketConnected: false });
    for (let i = 0; i < 5; i += 1) {
      l.socket.connected = false;
      l.doc.show();
      l.socket.connected = true;
      l.advance(1500);
      l.tick();
      l.advance(2500);
      l.doc.hide();
      l.advance(1000);
    }
    expect(l.pairs()).toBe(5);
    // The last return's handshake is still owed its read, on a timer.
    expect(l.timers.size).toBe(1);
  });

  test('a forced read on the return cancels a deferred one, since it is later than the reconnect behind it', () => {
    const l = lists({ socketConnected: true });
    l.doc.visibilityState = 'visible';
    l.tick();
    l.advance(2000);
    l.tick();
    expect(l.timers.size).toBe(1);
    l.doc.hide();
    l.socket.connected = false;
    l.doc.show();
    expect(l.pairs()).toBe(2);
    expect(l.timers.size).toBe(0);
  });

  test('a flapping socket reads the pair at most once per window', () => {
    const l = lists({ socketConnected: true });
    l.doc.visibilityState = 'visible';
    // A tick on every two-second sample for a minute, which the heard drop
    // now makes possible. With no gap of its own that was thirty pairs; now
    // it is the first tick and one at the end of each twelve-second window.
    for (let elapsed = 0; elapsed < 60000; elapsed += 2000) {
      l.tick();
      l.advance(2000);
      l.fireDue();
    }
    expect(l.pairs()).toBe(1 + 60000 / CATCHUP_MIN_GAP_MS);
    expect(l.timers.size).toBe(0);
  });

  test('a deferred read that comes due while hidden is held for the return', () => {
    const l = lists({ socketConnected: true });
    l.doc.visibilityState = 'visible';
    l.tick();
    l.advance(1000);
    l.tick();
    l.doc.hide();
    l.fireTimers();
    expect(l.pairs()).toBe(1);
    expect(l.listsGapPendingRef.current).toBe(true);
    l.doc.show();
    expect(l.pairs()).toBe(2);
    expect(l.listsGapPendingRef.current).toBe(false);
  });

  test('the listener and a deferred read come off on unmount', () => {
    const l = lists({ socketConnected: true });
    l.doc.visibilityState = 'visible';
    l.tick();
    l.advance(1000);
    l.tick();
    expect(l.timers.size).toBe(1);
    expect(l.doc.listeners.size).toBe(1);
    l.cleanup();
    expect(l.doc.listeners.size).toBe(0);
    expect(l.timers.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The sampler hears the drop
// ---------------------------------------------------------------------------
function sampler() {
  const state = { connected: true, ticks: 0, sample: null, onDrop: null, cleared: false, off: false };
  const socketAliveRef = { current: null };
  run(effectAround('const offDisconnect = onSocketDisconnect('), {
    useEffect: (fn) => { state.cleanup = fn(); },
    setInterval: (fn) => { state.sample = fn; return 1; },
    clearInterval: () => { state.cleared = true; },
    getSocket: () => ({ connected: state.connected }),
    socketAliveRef,
    // The snapshot of what was on screen while the socket was up, which the
    // same tick keeps (chatEchoOrderAndRetraction.test.js runs that part).
    catchUpOwedRef: { current: false },
    heldWhileUpRef: { current: null },
    flocksRef: { current: [] },
    directMessagesRef: { current: [] },
    setReconnectTick: (f) => { state.ticks = f(state.ticks); },
    SOCKET_SAMPLE_MS: 2000,
    onSocketDisconnect: (cb) => { state.onDrop = cb; return () => { state.off = true; }; },
  });
  return { state, socketAliveRef };
}

describe('a drop the sampler never ticked through', () => {
  test('without the disconnect, two live samples in a row are no reconnect: the old hole', () => {
    const { state } = sampler();
    state.sample();
    // Hidden, released, timers suspended, back and reconnected before the
    // next tick: the sampler sees live, then live.
    state.sample();
    expect(state.ticks).toBe(0);
  });

  test('the disconnect is heard, so the first live sample after it is a reconnect', () => {
    const { state, socketAliveRef } = sampler();
    state.sample();
    state.onDrop('io client disconnect');
    expect(socketAliveRef.current).toBe(false);
    state.sample();
    expect(state.ticks).toBe(1);
  });

  test('a first connect is still not a reconnect', () => {
    const { state } = sampler();
    state.sample();
    expect(state.ticks).toBe(0);
  });

  test('both the timer and the subscription are released on unmount', () => {
    const { state } = sampler();
    state.cleanup();
    expect(state.cleared).toBe(true);
    expect(state.off).toBe(true);
  });
});

describe('socket.js onSocketDisconnect', () => {
  const instances = socketIoClient.__instances;
  beforeEach(() => {
    localStorage.clear();
    disconnectSocket();
    instances.length = 0;
  });
  afterEach(() => disconnectSocket());

  test('goes through the registry, so it survives a swap onto a new instance', () => {
    const seen = [];
    const off = onSocketDisconnect((reason) => seen.push(reason));
    localStorage.setItem('flockToken', 'token-a');
    connectSocket();
    localStorage.setItem('flockToken', 'token-b');
    connectSocket();
    expect(instances).toHaveLength(2);
    instances[1].fire('disconnect', 'io client disconnect');
    expect(seen).toEqual(['io client disconnect']);
    off();
    instances[1].fire('disconnect', 'transport close');
    expect(seen).toEqual(['io client disconnect']);
  });
});
