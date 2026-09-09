/**
 * checkinDoneAt is a per-place map, and nothing may write any other shape
 * into it.
 *
 * It started life as one timestamp. When it became a map keyed by place_id
 * (so the two-hour check-in gate survives a reload and a second venue), one
 * writer was missed: the sensor effect on Discover kept setting it to `null`
 * with no active venue and to a bare number with one. The venue card's first
 * render then called lastCheckinAt, which indexed into null, and the Discover
 * tab fell into its error boundary ("The map stopped working, null is not an
 * object (evaluating 'checkinDoneAt[e]')") on EVERY tap of a map pin and every
 * results row that opened a card. The demonstration recording was the first
 * thing to notice, because nothing else ever rendered the card in a test.
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

describe('checkinDoneAt', () => {
  test('is initialised as a map', () => {
    expect(APP).toMatch(/const \[checkinDoneAt, setCheckinDoneAt\] = useState\(\{\}\);/);
  });

  test('every writer keeps it a map: functional updates that spread the previous value only', () => {
    const calls = (APP.match(/setCheckinDoneAt\(/g) || []).length;
    const spreads = (APP.match(/setCheckinDoneAt\(\(prev\) => \(\{ \.\.\.prev,/g) || []).length;
    expect(calls).toBeGreaterThan(0);
    // Every call site is the spreading functional update; none passes null,
    // a number, or anything else that is not the map.
    expect(spreads).toBe(calls);
  });

  test('the reader tolerates a non-object, so a stale writer cannot take the map screen down', () => {
    expect(APP).toMatch(/if \(checkinDoneAt && typeof checkinDoneAt === 'object' && checkinDoneAt\[placeId\]\) return checkinDoneAt\[placeId\];/);
  });
});
