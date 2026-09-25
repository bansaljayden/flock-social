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
 * App.js and run.
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

  test('and no share starts in a plan that is over, with the reason said', () => {
    const start = app.slice(app.indexOf('const startSharingLocation = useCallback('), app.indexOf('setMyTravel(travel);', app.indexOf('const startSharingLocation = useCallback(')));
    expect(start).toMatch(/if \(plan && \(plan\.status === 'completed' \|\| plan\.status === 'cancelled'\)\) \{\s*showToast\('This plan is over, so there is nobody to share your location with\.', 'error'\);\s*return;/);
  });
});
