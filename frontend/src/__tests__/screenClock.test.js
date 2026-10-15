/**
 * THE APP RENDERS ON THE MINUTE WHILE IT IS VISIBLE.
 *
 * A good number of things on screen are read off the clock during render and
 * have no timer of their own: "Today" and "Yesterday", a plan turning into
 * "How was it?" an hour after it, Live Events dropping an event as it starts,
 * "set 3 min ago", the calendar's today. They used to move whenever anything
 * at all re-rendered the app, typing in the last chat opened and every toast
 * going away included. Neither of those renders the whole app any more, so the
 * app keeps its own minute: aligned to the minute, so a boundary that falls on
 * one turns over on time, and off while the app is hidden.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test screenClock --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

describe('the minute the screens are drawn against', () => {
  const start = app.indexOf('const [, setClockMinute] = useState(0);');
  const effect = start === -1 ? '' : app.slice(start, start + 600);

  test('it exists, and it is the app that keeps it', () => {
    expect(start).toBeGreaterThan(-1);
    expect(effect).toMatch(/setClockMinute\(Math\.floor\(Date\.now\(\) \/ 60000\)\);/);
  });

  test('it ticks on the minute, not a minute after whenever it started', () => {
    expect(effect).toMatch(/60000 - \(Date\.now\(\) % 60000\) \+ 50/);
  });

  test('it does not run while nobody can see the app', () => {
    expect(effect).toMatch(/if \(!docVisible\) return undefined;/);
    expect(effect).toMatch(/return \(\) => clearTimeout\(timer\);\s*\}, \[docVisible\]\);/);
  });
});
