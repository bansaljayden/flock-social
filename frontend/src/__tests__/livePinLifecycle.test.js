/**
 * WHEN A LIVE PIN COMES OFF, AND WHEN A SHARE STOPS.
 *
 * App.js keeps one map of member positions for the session and used to drop
 * an entry on member_stopped_sharing alone. A block, a departure, a deleted
 * plan, a cancelled or finished one, and a stop missed while offline all left
 * the pin on the map, live dot and all, until a reload. The sharer's side had
 * the matching hole: the app went on sending a position every ten seconds into
 * a plan that had been deleted, left from another device or called off, and
 * the server refused every one of them at its membership check.
 *
 * The backend half (sockets/handlers.js: who each pin was handed to, and a
 * stop for every way a share ends) is pinned in the backend suites. This file
 * pins the app half: lib/livePins.js's three rules, the handlers that use
 * them, the staleness beat, and the share's auto-stop, which is lifted out of
 * App.js and run. So are the two position listeners, which drop a position
 * from somebody blocked, and the stop, which ends this device's share and no
 * one else's pin. The auto-stop ends a share when its plan LEAVES confirmed,
 * never because a plan still being decided is not confirmed yet. A share
 * moved from one plan to another ends in the first through that same stop,
 * before anything goes to the second.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const {
  LOCATION_EMIT_MS, PIN_STALE_AFTER_MS, withoutFlockPins, withoutPersonPin, withoutStalePins,
} = require('../lib/livePins');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

const pin = (flockId, receivedAt = 1000, extra = {}) => ({ lat: 1, lng: 2, name: 'Sam', flockId, receivedAt, timestamp: receivedAt, ...extra });

/**
 * The index just past the brace that closes the one at `open`, skipping
 * strings and comments, so a lifted body can hold either.
 */
function closeOf(source, open) {
  let i = open;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
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
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  throw new Error('closeOf: unbalanced source');
}

/** The arrow function a socket subscription is handed, by the line that subscribes. */
function liftListener(opener) {
  const at = app.indexOf(opener);
  if (at === -1) throw new Error(`listener not found: ${opener}`);
  const start = at + opener.length;
  return app.slice(start, closeOf(app, app.indexOf('{', app.indexOf('=>', start))));
}

/** The function a `const <name> = useCallback(...)` wraps, as source. */
function liftCallbackFn(name) {
  const marker = `  const ${name} = useCallback(`;
  const at = app.indexOf(marker);
  if (at === -1) throw new Error(`callback not found: ${name}`);
  const start = at + marker.length;
  return app.slice(start, closeOf(app, app.indexOf('{', app.indexOf('=>', start))));
}

/** Run lifted source against named stand-ins for what it closes over. */
function runLifted(src, scope) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(scope), src)(...Object.values(scope));
}

describe('lib/livePins: the three ways a pin comes off', () => {
  test('one person, scoped to the plan they left, and every plan when blocked', () => {
    const pins = { 7: pin(1), 8: pin(2) };
    expect(withoutPersonPin(pins, 7, 1)).toEqual({ 8: pin(2) });
    // Leaving plan 2 does not take a pin Sam is sharing in plan 1.
    expect(withoutPersonPin(pins, 7, 2)).toBe(pins);
    // A block has no plan: the pin goes wherever it is.
    expect(withoutPersonPin(pins, '7')).toEqual({ 8: pin(2) });
    // An older server's entry with no flock is cleared as a stop clears it.
    expect(withoutPersonPin({ 7: pin(null) }, 7, 3)).toEqual({});
  });

  test('every pin of a plan, for one id or a list', () => {
    const pins = { 7: pin(1), 8: pin(1), 9: pin(2), 10: pin(null) };
    expect(withoutFlockPins(pins, 1)).toEqual({ 9: pin(2), 10: pin(null) });
    expect(withoutFlockPins(pins, ['1', 2])).toEqual({ 10: pin(null) });
    expect(withoutFlockPins(pins, 99)).toBe(pins);
  });

  test('a pin with nothing new for six sends comes off, measured on this device\'s clock', () => {
    expect(LOCATION_EMIT_MS).toBe(10000);
    expect(PIN_STALE_AFTER_MS).toBe(6 * LOCATION_EMIT_MS);
    const now = 1_000_000;
    const pins = {
      fresh: pin(1, now - 5000),
      edge: pin(1, now - PIN_STALE_AFTER_MS),
      stale: pin(1, now - PIN_STALE_AFTER_MS - 1),
      // The server stamped this one far in the past (a phone clock that runs
      // fast would look like this too); it landed here just now, so it stays.
      skewed: { ...pin(1, now - 1000), timestamp: now - 10 * 60 * 1000 },
      noClock: { lat: 1, lng: 2, flockId: 1 },
    };
    expect(Object.keys(withoutStalePins(pins, now)).sort()).toEqual(['edge', 'fresh', 'skewed']);
  });

  test('nothing to drop hands back the same map, so a quiet tick renders nothing', () => {
    const pins = { 7: pin(1, 5000) };
    expect(withoutStalePins(pins, 6000)).toBe(pins);
    expect(withoutFlockPins(pins, 2)).toBe(pins);
    expect(withoutPersonPin(pins, 8)).toBe(pins);
  });
});

describe('App.js drops the pin on every event that ends it', () => {
  const region = (from, to) => {
    const a = app.indexOf(from);
    const b = app.indexOf(to, a + from.length);
    if (a === -1 || b === -1) throw new Error(`region not found: ${from}`);
    return app.slice(a, b);
  };

  test('a block takes the person\'s pin, flock and DM alike', () => {
    const blocked = region('const handleUserBlocked = useCallback(', '  }, [selectedDmId, selectedFlockId,');
    expect(blocked).toMatch(/setFlockMemberLocations\(prev => withoutPersonPin\(prev, id\)\);/);
    expect(blocked).toMatch(/if \(keepDmOpen && String\(selectedDmId\) === id\) setDmMemberLocation\(null\);/);
  });

  test('a departure takes the leaver\'s pin in that plan', () => {
    const left = region('const unsub = onFlockMemberLeft((data) => {', 'return unsub;');
    expect(left).toMatch(/setFlockMemberLocations\(prev => withoutPersonPin\(prev, data\.userId, data\.flockId\)\);/);
  });

  test('a deleted plan takes every pin shown from it', () => {
    const deleted = region('const unsub = onFlockDeleted((data) => {', 'return unsub;');
    expect(deleted).toMatch(/setFlockMemberLocations\(prev => withoutFlockPins\(prev, data\.flockId\)\);/);
  });

  test('a plan that is over, by the host\'s Cancel, the done slide or the sweep, takes its pins', () => {
    const over = region('// A PLAN THAT IS OVER TAKES ITS PINS WITH IT.', '// Clean up location sharing on unmount.');
    expect(over).toMatch(/\(f\.status === 'completed' \|\| f\.status === 'cancelled'\)/);
    expect(over).toMatch(/setFlockMemberLocations\(prev => withoutFlockPins\(prev, over\)\)/);
    expect(over).toMatch(/\}, \[flocks, flockMemberLocations\]\);/);
  });

  test('a stop missed while offline is bounded: stale pins are swept on the send beat', () => {
    const sweep = region('// A PIN THAT HAS STOPPED MOVING COMES OFF.', '// A PLAN THAT IS OVER TAKES ITS PINS WITH IT.');
    expect(sweep).toMatch(/setFlockMemberLocations\(prev => withoutStalePins\(prev, Date\.now\(\)\)\);\s*\}, LOCATION_EMIT_MS\);/);
    expect(sweep).toMatch(/if \(!hasMemberPins\) return undefined;/);
    // Every position records when it landed here; the flock still rides along
    // (whoIsHereScoping.test.js pins that half).
    expect(app).toMatch(/seats: data\.seats, receivedAt: Date\.now\(\), timestamp: data\.timestamp, flockId: data\.flockId \}/);
  });

  test('the sender and the receiver read one interval', () => {
    expect(app).toMatch(/if \(loc\) emitLocation\(sharingLocationForFlock, loc\.lat, loc\.lng, myTravelRef\.current\);\s*\}, LOCATION_EMIT_MS\);/);
  });

  test('a position already on its way when a block landed is dropped, flock and DM alike', () => {
    // The server stops sending at the block, but a position it read the
    // roster for just before can arrive just after. The flock pin came back
    // until the staleness sweep; the DM pin has no sweep and stayed.
    const blockedIdsRef = { current: new Set(['9']) };
    const state = { pins: {}, dm: null };
    const flockListener = runLifted(`return ${liftListener('const unsubLocation = onLocationUpdate(')};`, {
      blockedIdsRef,
      setFlockMemberLocations: (fn) => { state.pins = fn(state.pins); },
    });
    flockListener({ userId: 9, lat: 1, lng: 2, name: 'Cy', flockId: 4, timestamp: 5 });
    expect(state.pins).toEqual({});
    flockListener({ userId: 8, lat: 1, lng: 2, name: 'Sam', flockId: 4, timestamp: 5 });
    expect(Object.keys(state.pins)).toEqual(['8']);

    const dmListener = runLifted(`return ${liftListener('const unsubLoc = onDmLocationUpdate(')};`, {
      isOpenDm: () => true,
      blockedIdsRef,
      setDmMemberLocation: (v) => { state.dm = v; },
    });
    dmListener({ userId: 9, lat: 1, lng: 2, name: 'Cy', timestamp: 5 });
    expect(state.dm).toBeNull();
    dmListener({ userId: 8, lat: 1, lng: 2, name: 'Sam', timestamp: 5 });
    expect(state.dm).toEqual({ lat: 1, lng: 2, name: 'Sam', timestamp: 5 });
  });
});

describe("stopping this device's share leaves everyone else's pin", () => {
  function stopWith({ sharing = 4, chatOnScreen = null } = {}) {
    const calls = [];
    const myTravelRef = { current: { intent: 'omw' } };
    const stop = runLifted(`return ${liftCallbackFn('stopLocationSharing')};`, {
      sharingLocationForFlock: sharing,
      socketStopSharing: (id) => calls.push(['stop sent', id]),
      setMyTravel: (v) => calls.push(['travel', v]),
      myTravelRef,
      prevFlockIdRef: { current: chatOnScreen },
      leaveFlock: (id) => calls.push(['left room', id]),
      setSharingLocationForFlock: (v) => calls.push(['sharing', v]),
      // Other people's pins. The stop used to replace this whole map with {},
      // so every plan's live pins blinked out until their next send.
      setFlockMemberLocations: () => calls.push(['pin map replaced']),
    });
    stop();
    return { calls, myTravelRef };
  }

  test('the stop goes out and this device forgets its own share, and nothing else', () => {
    const { calls, myTravelRef } = stopWith();
    expect(calls).toEqual([['stop sent', 4], ['travel', null], ['left room', 4], ['sharing', null]]);
    expect(myTravelRef.current).toBeNull();
  });

  test('with that chat on screen the room is kept, and still no pin is touched', () => {
    expect(stopWith({ chatOnScreen: 4 }).calls).toEqual([['stop sent', 4], ['travel', null], ['sharing', null]]);
  });

  test('nothing sharing, nothing sent', () => {
    expect(stopWith({ sharing: null }).calls).toEqual([]);
  });
});

describe('a share moved to another plan ends in the first one the way a stop does', () => {
  // startSharingLocation and the stop it calls, both lifted out of App.js and
  // run over one log of what went on the wire and into state. The stop is the
  // real stopLocationSharing, closed over the share that is running, so this
  // holds only if the move takes the ordinary stop's path. Plan 4 is sharing;
  // plan 5's chat is on screen, where Share location was tapped.
  function startWith({
    sharing = 4,
    chatOnScreen = 5,
    plans = [{ id: 4, status: 'confirmed' }, { id: 5, status: 'voting' }],
  } = {}) {
    const calls = [];
    const myTravelRef = { current: null };
    const stop = runLifted(`return ${liftCallbackFn('stopLocationSharing')};`, {
      sharingLocationForFlock: sharing,
      socketStopSharing: (id) => calls.push(['stop sent', id]),
      setMyTravel: (v) => calls.push(['travel', v]),
      myTravelRef,
      prevFlockIdRef: { current: chatOnScreen },
      leaveFlock: (id) => calls.push(['left room', id]),
      setSharingLocationForFlock: (v) => calls.push(['sharing', v]),
    });
    const start = runLifted(`return ${liftCallbackFn('startSharingLocation')};`, {
      flocksRef: { current: plans },
      showToast: (message) => calls.push(['toast', message]),
      sharingLocationRef: { current: sharing },
      stopLocationSharingRef: { current: stop },
      setMyTravel: (v) => calls.push(['travel', v]),
      myTravelRef,
      userLocation: { lat: 40.7, lng: -74 },
      emitLocation: (id, lat, lng, travel) => calls.push(['position sent', id, travel]),
      setSharingLocationForFlock: (v) => calls.push(['sharing', v]),
      geolocationAvailable: () => true,
      getCurrentPosition: () => calls.push(['fix asked']),
      setUserLocation: () => {},
      trackLocationError: () => {},
    });
    return { calls, start, myTravelRef };
  }

  test("plan 4's stop goes out and its room is left before anything goes to plan 5", () => {
    const { calls, start, myTravelRef } = startWith();
    start(5, { intent: 'omw' });
    expect(calls).toEqual([
      // Exactly the ordinary stop, for the plan the share is leaving: the
      // server marks the share ended and takes the pin off plan 4's maps.
      ['stop sent', 4], ['travel', null], ['left room', 4], ['sharing', null],
      // Then the new share, as a share has always started.
      ['travel', { intent: 'omw' }], ['position sent', 5, { intent: 'omw' }], ['sharing', 5],
    ]);
    expect(myTravelRef.current).toEqual({ intent: 'omw' });
  });

  test('starting again in the plan already being shared sends no stop', () => {
    const { calls, start } = startWith({ sharing: 5 });
    start(5, { intent: 'omw' });
    expect(calls).toEqual([['travel', { intent: 'omw' }], ['position sent', 5, { intent: 'omw' }], ['sharing', 5]]);
  });

  test('with nothing running, a share starts exactly as before', () => {
    const { calls, start } = startWith({ sharing: null });
    start(5);
    expect(calls).toEqual([['travel', null], ['position sent', 5, null], ['sharing', 5]]);
  });

  test('a plan that is over is refused before the running share is touched', () => {
    const { calls, start } = startWith({ plans: [{ id: 4, status: 'confirmed' }, { id: 6, status: 'cancelled' }] });
    start(6);
    expect(calls).toEqual([['toast', 'This plan is over, so there is nobody to share your location with.']]);
  });

  test('the stop it calls is the current stopLocationSharing, read again every render', () => {
    expect(app).toMatch(/const stopLocationSharingRef = useRef\(stopLocationSharing\);\s*stopLocationSharingRef\.current = stopLocationSharing;/);
  });
});

describe('the share stops for a plan that is over or no longer this person\'s', () => {
  // The auto-stop effect, lifted and run with useEffect as a plain call.
  const body = (() => {
    const start = app.indexOf('  const sharingFlockStatusRef = useRef(null);');
    const end = app.indexOf('}, [flocks, sharingLocationForFlock, stopLocationSharing]);', start);
    if (start === -1 || end === -1) throw new Error('auto-stop effect not found');
    return app.slice(app.indexOf('useEffect(() => {', start) + 'useEffect(() => {'.length, end);
  })();

  function harness() {
    const state = { stops: 0, ref: { current: null } };
    // eslint-disable-next-line no-new-func
    const run = new Function('flocks', 'sharingLocationForFlock', 'stopLocationSharing', 'sharingFlockStatusRef', body);
    const step = (flocks, sharing) => run(flocks, sharing, () => { state.stops += 1; }, state.ref);
    return { state, step };
  }

  test('the lift found the effect', () => {
    expect(body.length).toBeGreaterThan(200);
  });

  test('a plan deleted, or left on another device, stops the share once it leaves the list', () => {
    const h = harness();
    h.step([{ id: 4, status: 'confirmed' }], 4);
    expect(h.state.stops).toBe(0);
    h.step([], 4);
    expect(h.state.stops).toBe(1);
  });

  test('a list that never held the plan stops nothing', () => {
    const h = harness();
    h.step([], 4);
    expect(h.state.stops).toBe(0);
  });

  test('a cancelled or finished plan stops the share, on the first look as well as later', () => {
    for (const status of ['cancelled', 'completed']) {
      const first = harness();
      first.step([{ id: 4, status }], 4);
      expect({ status, stops: first.state.stops }).toEqual({ status, stops: 1 });
      const later = harness();
      later.step([{ id: 4, status: 'confirmed' }], 4);
      later.step([{ id: 4, status }], 4);
      expect({ status, stops: later.state.stops }).toEqual({ status, stops: 1 });
    }
  });

  test('a live confirmed plan keeps sharing', () => {
    const h = harness();
    h.step([{ id: 4, status: 'confirmed' }], 4);
    h.step([{ id: 4, status: 'confirmed', name: 'renamed' }], 4);
    expect(h.state.stops).toBe(0);
  });

  test('a share started while the plan is still being decided survives every update', () => {
    // The chat offers a share wherever somebody else is in the flock, so it
    // can start at 'voting' (the client's word for the server's 'planning').
    // A chat message, a roster refresh and a return from the background are
    // each a new flocks array, and the first of them used to stop the share
    // because 'voting' is not 'confirmed'.
    const h = harness();
    h.step([{ id: 4, status: 'voting' }], 4);
    h.step([{ id: 4, status: 'voting', messages: [{ id: 1 }] }], 4);
    h.step([{ id: 4, status: 'voting', members: [{ id: 2 }] }], 4);
    expect(h.state.stops).toBe(0);
    // Locked in while it runs: it keeps going.
    h.step([{ id: 4, status: 'confirmed' }], 4);
    h.step([{ id: 4, status: 'confirmed', name: 'renamed' }], 4);
    expect(h.state.stops).toBe(0);
  });

  test('leaving confirmed is what stops it, whatever it started as', () => {
    const lockedFirst = harness();
    lockedFirst.step([{ id: 4, status: 'confirmed' }], 4);
    lockedFirst.step([{ id: 4, status: 'voting' }], 4);
    expect(lockedFirst.state.stops).toBe(1);
    const votingFirst = harness();
    votingFirst.step([{ id: 4, status: 'voting' }], 4);
    votingFirst.step([{ id: 4, status: 'confirmed' }], 4);
    votingFirst.step([{ id: 4, status: 'voting' }], 4);
    expect(votingFirst.state.stops).toBe(1);
  });

  test('a plan still being decided that is called off, finished or gone still stops it', () => {
    for (const next of [[{ id: 4, status: 'cancelled' }], [{ id: 4, status: 'completed' }], []]) {
      const h = harness();
      h.step([{ id: 4, status: 'voting' }], 4);
      h.step(next, 4);
      expect({ next, stops: h.state.stops }).toEqual({ next, stops: 1 });
    }
    // A plan that arrived with no status at all was still on the list.
    const bare = harness();
    bare.step([{ id: 4 }], 4);
    bare.step([], 4);
    expect(bare.state.stops).toBe(1);
  });

  test('a share moved to a second plan is judged by that plan, not the first one', () => {
    // Sharing in confirmed plan 4, then Share location in the chat of plan 5,
    // still being decided. The share moves straight from 4 to 5, and used to
    // carry 4's 'confirmed' with it: 5's 'voting' read as a step out of
    // confirmed, and the new share stopped after its first position.
    const plans = [{ id: 4, status: 'confirmed' }, { id: 5, status: 'voting' }];
    const h = harness();
    h.step(plans, 4);
    h.step(plans, 5);
    expect(h.state.stops).toBe(0);
    // And every update after it, as the share runs.
    h.step([{ id: 4, status: 'confirmed' }, { id: 5, status: 'voting', messages: [{ id: 1 }] }], 5);
    expect(h.state.stops).toBe(0);
    // Plan 5's own rule still holds: locked in, then out again, stops it.
    h.step([{ id: 4, status: 'confirmed' }, { id: 5, status: 'confirmed' }], 5);
    h.step([{ id: 4, status: 'confirmed' }, { id: 5, status: 'voting' }], 5);
    expect(h.state.stops).toBe(1);
  });

  test('a share moved to a plan the list has not loaded yet is not taken for a plan that went away', () => {
    const h = harness();
    h.step([{ id: 4, status: 'confirmed' }], 4);
    h.step([{ id: 4, status: 'confirmed' }], 6);
    expect(h.state.stops).toBe(0);
    // Once plan 6 has been on the list, its leaving does stop the share.
    h.step([{ id: 4, status: 'confirmed' }, { id: 6, status: 'voting' }], 6);
    h.step([{ id: 4, status: 'confirmed' }], 6);
    expect(h.state.stops).toBe(1);
  });

  test('and no share starts in a plan that is over, with the reason said', () => {
    const start = app.slice(app.indexOf('const startSharingLocation = useCallback('), app.indexOf('setMyTravel(travel);', app.indexOf('const startSharingLocation = useCallback(')));
    expect(start).toMatch(/if \(plan && \(plan\.status === 'completed' \|\| plan\.status === 'cancelled'\)\) \{\s*showToast\('This plan is over, so there is nobody to share your location with\.', 'error'\);\s*return;/);
  });
});
