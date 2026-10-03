/**
 * The four people searches (invite, connect, Add Friends, New Message) each
 * debounce a call to searchUsers. Two defects, both fixed 2026-10-03:
 *
 * 1. Emptying the box cancelled the pending timer but never cleared the
 *    spinner flag, so New Message and Add Friends sat on "Searching..." with
 *    their suggestions hidden until the next search.
 * 2. Nothing tied an answer to its query, so a slow answer for "jo" could land
 *    after, and overwrite, the answer for "jordan".
 *
 * Each handler now numbers its queries; only the latest one's answer, error or
 * spinner change is applied. This is a FRONTEND test (jest via react-scripts),
 * reading App.js as source, because the handlers live inside the App
 * component.
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

const HANDLERS = [
  { name: 'handleInviteSearch', seq: 'inviteSeqRef', busy: 'setInviteSearching' },
  { name: 'handleConnectSearch', seq: 'connectSeqRef', busy: 'setConnectSearching' },
  { name: 'handleAddFriendsSearch', seq: 'addFriendsSeqRef', busy: 'setAddFriendsSearching' },
  { name: 'handleDmSearch', seq: 'dmModalSeqRef', busy: 'setDmModalSearching' },
];

function body(name) {
  const start = APP.indexOf(`const ${name} = useCallback((val) => {`);
  expect(start).toBeGreaterThan(-1);
  return APP.slice(start, APP.indexOf('}, []);', start));
}

describe.each(HANDLERS)('$name', ({ name, seq, busy }) => {
  test('emptying the box clears the spinner', () => {
    const b = body(name);
    const empty = /if \(val\.trim\(\)\.length < 1\) \{([^}]*)\}/.exec(b);
    expect(empty).not.toBeNull();
    expect(empty[1]).toContain(`${busy}(false);`);
  });

  test('every keystroke, the clearing ones included, starts a new sequence', () => {
    const b = body(name);
    const bump = b.indexOf(`const mine = ++${seq}.current;`);
    const empty = b.indexOf('if (val.trim().length < 1)');
    expect(bump).toBeGreaterThan(-1);
    expect(bump).toBeLessThan(empty);
  });

  test('an overtaken answer, error or spinner change is dropped', () => {
    const b = body(name);
    const guards = b.split(`if (mine !== ${seq}.current) return;`).length - 1;
    expect(guards).toBe(2); // after the await, and at the top of the catch
    expect(b).toContain(`finally { if (mine === ${seq}.current) ${busy}(false); }`);
  });
});
