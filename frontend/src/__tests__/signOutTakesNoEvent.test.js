/**
 * SIGNING OUT FROM THE VENUE DASHBOARD DOES NOT CRASH THE APP.
 *
 * onLogout's one argument is the sentence the sign-in screen shows after a
 * sign-out ("Your account was deleted.", and so on). VenueDashboard's Sign out
 * button was `onClick={onLogout}`, so React handed it the click event: an
 * object, truthy, kept as that sentence and rendered, and "objects are not
 * valid as a React child" (React error #31) took the whole app down to the
 * root crash card. The click-through crawl of the venue portal on 2026-11-11
 * hit it on the first press of Sign out.
 *
 * Pinned: the button calls onLogout with nothing; nothing in the app hands
 * onLogout straight to onClick; and App.js's adapter keeps only a string, so
 * the next slip of the same kind is a plain sign-out rather than a crash.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test signOutTakesNoEvent --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
// Comments out, so a comment that quotes the old line does not count.
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function sourceFiles(dir = SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('the dashboard\'s Sign out calls onLogout with nothing', () => {
  const dash = read('screens', 'VenueDashboard.js');
  expect(dash).toMatch(/<button aria-label="Sign out" className="hit44" onClick=\{\(\) => onLogout\(\)\}/);
});

test('nothing hands onLogout straight to onClick', () => {
  const offenders = sourceFiles().filter((f) => /onClick=\{\s*onLogout\s*\}/.test(codeOnly(fs.readFileSync(f, 'utf8'))));
  expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
});

describe('App.js keeps only a string as the sign-out sentence', () => {
  const APP = read('App.js');
  // The same lift signOutClearsDevice.test.js makes of this prop.
  const expr = APP.match(/onLogout=\{((?:[^{}]|\{[^{}]*\})*)\}/);
  // eslint-disable-next-line no-new-func
  const adapter = (endSession) => new Function('endSession', `return ${expr[1]};`)(endSession);

  const call = (note) => {
    const endSession = jest.fn();
    adapter(endSession)(note);
    return endSession.mock.calls;
  };

  test('the adapter was found', () => {
    expect(expr).toBeTruthy();
    expect(expr[1]).toMatch(/typeof note === 'string'/);
  });

  test('a click event signs out with no sentence', () => {
    const clickEvent = { type: 'click', nativeEvent: {}, target: {}, currentTarget: {}, preventDefault() {} };
    expect(call(clickEvent)).toEqual([['', { specific: false }]]);
  });

  test('nothing signs out with no sentence', () => {
    expect(call(undefined)).toEqual([['', { specific: false }]]);
  });

  test('a sentence is kept, and counts as a named reason', () => {
    expect(call('Your account was deleted.')).toEqual([['Your account was deleted.', { specific: true }]]);
  });
});
