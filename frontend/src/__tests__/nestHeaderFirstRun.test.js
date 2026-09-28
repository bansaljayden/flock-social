/**
 * THE NEST HEADER, AS A BRAND-NEW ACCOUNT FIRST SEES IT.
 *
 * Three things sat above the empty state on a new account's first screen and
 * each one said something that was not so:
 *
 * 1. "0 flocks · 0 friends". A tally of nothing, directly above an empty
 *    state that already says there are no flocks and offers Start a flock and
 *    Add friends at full size.
 * 2. The Tonight? pulse, Down / Maybe / Not, captioned "Friends see your
 *    answer until it clears at 4 AM." With no friends that caption is false,
 *    and it was the first interactive thing on the screen.
 * 3. The greeting that cycles above the name. One of its lines was "Rounding
 *    up the group...", which on an empty screen reads as the app still
 *    loading, and every line arrived on an overshoot curve that bounced it
 *    past its slot and back.
 *
 * HomeScreen is declared inside FlockAppInner, so it cannot be rendered on its
 * own. What can be done without rendering it is done: the two guards are
 * lifted out of App.js and run against the states that matter, including the
 * one where the stats read has not landed (friendCount null), which must not
 * be read as zero. The greeting list is lifted and every line is called.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestHeaderFirstRun --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const HOME = (() => {
  const at = APP.indexOf('const HomeScreen = () => {');
  expect(at).toBeGreaterThan(-1);
  return APP.slice(at, APP.indexOf('{/* Scrollable Content */}', at));
})();
const LINES = HOME.split('\n');

// The JSX guard wrapping the element whose first line matches `opens`, where
// the element's content includes `marker`. Returned as the expression text
// between `{` and `&& (`, which is what gets run below.
function guardAbove(marker, opens) {
  const markerLine = LINES.findIndex((l) => l.includes(marker));
  expect(markerLine).toBeGreaterThan(-1);
  let open = markerLine;
  while (open >= 0 && !opens.test(LINES[open])) open -= 1;
  expect(open).toBeGreaterThan(-1);
  const guard = LINES[open - 1].trim().match(/^\{(.+) && \((<>)?$/);
  expect(guard).not.toBeNull();
  return { expr: guard[1], line: open - 1 };
}

// Runs a lifted guard. Only the names the header reads are in scope, so a
// guard that grew a new dependency fails here instead of passing on undefined.
const run = (expr, scope) => new Function('liveFlocks', 'friendCount', 'myPulse', `return (${expr});`)(
  scope.liveFlocks, scope.friendCount, scope.myPulse
);

describe('the stat line', () => {
  const { expr } = guardAbove("{liveFlocks.length}</span> {liveFlocks.length === 1 ? 'flock' : 'flocks'}", /^\s*<p /);

  test('is not drawn when there are no flocks and the stats read said no friends', () => {
    expect(run(expr, { liveFlocks: [], friendCount: 0, myPulse: null })).toBe(false);
  });

  test('is drawn while the friend count is still unknown: null is not zero', () => {
    expect(run(expr, { liveFlocks: [], friendCount: null, myPulse: null })).toBe(true);
  });

  test('is drawn as soon as either number is something', () => {
    expect(run(expr, { liveFlocks: [], friendCount: 3, myPulse: null })).toBe(true);
    expect(run(expr, { liveFlocks: [{ id: 1 }], friendCount: 0, myPulse: null })).toBe(true);
  });
});

describe('the Tonight? pulse', () => {
  const { expr, line } = guardAbove('>Tonight?</span>', /^\s*<div /);

  test('is not offered to an account with no friends to see the answer', () => {
    expect(run(expr, { liveFlocks: [], friendCount: 0, myPulse: null })).toBeFalsy();
  });

  test('stays while the friend count is still unknown, so a slow read does not hide it', () => {
    expect(run(expr, { liveFlocks: [], friendCount: null, myPulse: null })).toBeTruthy();
  });

  test('is offered once there is a friend', () => {
    expect(run(expr, { liveFlocks: [], friendCount: 1, myPulse: null })).toBeTruthy();
  });

  test('an answer already set keeps the control, so it can be changed or cleared', () => {
    expect(run(expr, { liveFlocks: [], friendCount: 0, myPulse: { status: 'down' } })).toBeTruthy();
  });

  test('the caption goes with the control, not after it', () => {
    // The fragment the guard opens closes after the caption, so "Friends see
    // your answer" is never drawn under a control that is not there.
    const rest = LINES.slice(line).join('\n');
    const close = rest.indexOf('</>)}');
    expect(close).toBeGreaterThan(-1);
    expect(rest.slice(0, close)).toContain('Friends see your answer until it clears at 4 AM.');
    expect(rest.slice(close)).not.toContain('Friends see your answer');
  });
});

describe('the cycling greeting', () => {
  const src = APP.slice(APP.indexOf('const GREETINGS = ['), APP.indexOf('];', APP.indexOf('const GREETINGS = [')) + 2);
  // eslint-disable-next-line no-new-func
  const GREETINGS = new Function(`${src.replace('const GREETINGS =', 'return')}`)();

  test('every line is a greeting, and none of them reads as something loading', () => {
    expect(GREETINGS.length).toBeGreaterThan(1);
    for (const line of GREETINGS) {
      const said = line();
      expect(typeof said).toBe('string');
      expect(said).not.toMatch(/(\.\.\.|…)$/);
      expect(said).not.toMatch(/Rounding up/i);
    }
  });

  test('the spin eases out and stops, with no overshoot', () => {
    const body = APP.slice(APP.indexOf('const CyclingGreeting = React.memo('), APP.indexOf('});', APP.indexOf('const CyclingGreeting = React.memo(')));
    const curve = body.match(/animation: 'slotSpin [\d.]+s cubic-bezier\(([^)]+)\)'/);
    expect(curve).not.toBeNull();
    const [, y1, , y2] = curve[1].split(',').map(Number);
    // A y outside 0..1 is a curve that runs past its end value and comes
    // back, which is the bounce.
    for (const y of [y1, y2]) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });
});
