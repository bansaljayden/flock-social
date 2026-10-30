/**
 * TAPS ANSWER AT ONCE, AND A REFUSAL PUTS THEM BACK.
 *
 * A UX review of the app's basics (2026-10-30) found the controls people press
 * most waiting a whole round trip before anything moved: a DM reaction, an
 * unsend, a pin, declining a plan, answering a friend request, a settings
 * switch. On a bar's network that wait reads as a tap that missed, and it
 * invites the second tap that then races the first. Each of these now changes
 * the screen on the tap, sends the write, and on a refusal puts back exactly
 * what was there before, with a toast that names what did not happen. A second
 * tap while the first is out sends nothing.
 *
 * The handlers live inside components thousands of lines long, so each one is
 * lifted out of its source file and run against stand-ins for React's state
 * and the API, the way chatEchoOrderAndRetraction.test.js runs App.js's
 * listeners. What runs here is the code that ships.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test tapsAnswerAtOnce --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');
const DM = read('screens', 'DmDetail.js');

/** Index just past the string, template literal or comment starting at i, or -1 when none starts there. */
function skipQuoted(source, i) {
  const ch = source[i];
  const next = source[i + 1];
  if (ch === '/' && next === '/') {
    const end = source.indexOf('\n', i);
    return end === -1 ? source.length : end;
  }
  if (ch === '/' && next === '*') {
    const end = source.indexOf('*/', i + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    let j = i + 1;
    while (j < source.length) {
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === ch) return j + 1;
      j += 1;
    }
    return source.length;
  }
  return -1;
}

/** The `const name = ...;` statement that starts at `marker`, brace-matched to its own semicolon. */
function statementAt(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`statementAt: no \`${marker}\` in source`);
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const skipped = skipQuoted(source, i);
    if (skipped !== -1) { i = skipped; continue; }
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`statementAt: \`${marker}\` never ends`);
}

/** The body of the first `{ ... }` block that opens inside or after `marker`, without its braces. */
function blockAfter(source, marker) {
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`blockAfter: no \`${marker}\` in source`);
  const open = source.indexOf('{', at);
  let i = open;
  let depth = 0;
  while (i < source.length) {
    const skipped = skipQuoted(source, i);
    if (skipped !== -1) { i = skipped; continue; }
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
    i += 1;
  }
  throw new Error(`blockAfter: \`${marker}\` never closes`);
}

/** Evaluates `src` with `scope` in reach and hands back the binding `name`. */
function lift(src, name, scope) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(scope), `${src}\nreturn ${name};`)(...Object.values(scope));
}

/** A setter that behaves like useState's: a function is applied to the state. */
const setterOn = (state, key) => (next) => { state[key] = typeof next === 'function' ? next(state[key]) : next; };

/** A promise the test settles itself. */
function held() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** api.js's userMessage, by its rule: only an error it built for people speaks. */
const userMessage = (err, fallback) => (err && (err.userFacing || err.isNetworkError || err.sessionExpired) && err.message ? err.message : fallback);

const refusal = (message, extra = {}) => Object.assign(new Error(message), { userFacing: true, status: 400, ...extra });
const crash = () => new TypeError("Cannot read properties of undefined (reading 'id')");

// ---------------------------------------------------------------------------
// DM reactions (screens/DmDetail.js toggleDmReaction)
// ---------------------------------------------------------------------------
describe('a DM reaction moves on the tap', () => {
  const { groupReactions } = require('../components/chat/MessageRow');
  const ME = 9;
  const FRIEND = 4;
  const heart = (userId, name) => ({ emoji: '❤️', user_id: userId, user_name: name });

  function setup({ reactions = [], answer, id = 501 } = {}) {
    const state = {
      directMessages: [
        { userId: FRIEND, messages: [{ id, sender: 'Ava', text: 'see you there', reactions }] },
        { userId: 77, messages: [{ id: 900, sender: 'Cy', text: 'other thread', reactions: [] }] },
      ],
    };
    const calls = { add: [], remove: [], toasts: [] };
    const send = (kind) => (messageId, emoji) => {
      calls[kind].push([messageId, emoji]);
      return answer ? answer(kind) : Promise.resolve({});
    };
    const scope = {
      React: { useRef: (v) => ({ current: v }) },
      selectedDmId: FRIEND,
      authUser: { id: ME, name: 'Jo' },
      groupReactions,
      originalDmRow: (m) => state.directMessages[0].messages.find((x) => x.id === m.id) || m,
      setDirectMessages: setterOn(state, 'directMessages'),
      addDmReaction: send('add'),
      removeDmReaction: send('remove'),
      showToast: (message, type) => calls.toasts.push([message, type]),
      userMessage,
    };
    const src = `${statementAt(DM, 'const dmReactionBusyRef = React.useRef(')}\n${statementAt(DM, 'const toggleDmReaction = (emoji, m) =>')}`;
    const toggle = lift(src, 'toggleDmReaction', scope);
    const row = () => state.directMessages[0].messages[0];
    return { state, calls, toggle, row };
  }

  test('a heart is drawn before the server has answered, and the write goes over REST', async () => {
    const wait = held();
    const { calls, toggle, row } = setup({ answer: () => wait.promise });
    toggle('❤️', row());
    expect(row().reactions).toEqual([heart(ME, 'Jo')]);
    expect(calls.add).toEqual([[501, '❤️']]);
    wait.resolve({ reaction: {} });
    await wait.promise;
    expect(row().reactions).toEqual([heart(ME, 'Jo')]);
    expect(calls.toasts).toEqual([]);
  });

  test("a refusal takes back this tap alone, and the other person's reaction from meanwhile stays", async () => {
    const wait = held();
    const { state, calls, toggle, row } = setup({ answer: () => wait.promise });
    toggle('❤️', row());
    // Ava hearts it too while the write is out (the live echo of her tap).
    setterOn(state, 'directMessages')((prev) => prev.map((d, i) => (i === 0
      ? { ...d, messages: [{ ...d.messages[0], reactions: [...d.messages[0].reactions, heart(FRIEND, 'Ava')] }] }
      : d)));
    wait.reject(refusal('You can no longer interact with this user.', { status: 403 }));
    await wait.promise.catch(() => {});
    await Promise.resolve();
    expect(row().reactions).toEqual([heart(FRIEND, 'Ava')]);
    expect(calls.toasts).toEqual([['You can no longer interact with this user.', 'error']]);
  });

  test('a removal that fails puts the reaction back where it was, with copy of our own over a crash', async () => {
    const thumbs = { emoji: '👍', user_id: FRIEND, user_name: 'Ava' };
    const { calls, toggle, row } = setup({
      reactions: [heart(ME, 'Jo'), thumbs],
      answer: () => Promise.reject(crash()),
    });
    toggle('❤️', row());
    expect(row().reactions).toEqual([thumbs]);
    await new Promise((r) => setTimeout(r, 0));
    expect(row().reactions).toEqual([heart(ME, 'Jo'), thumbs]);
    expect(calls.remove).toEqual([[501, '❤️']]);
    expect(calls.toasts).toEqual([["Removing your reaction didn't save. Try again.", 'error']]);
  });

  test('ownership is compared as a string: a reaction stored with a string id is still yours to take back', async () => {
    const { calls, toggle, row } = setup({ reactions: [heart(String(ME), 'Jo')] });
    toggle('❤️', row());
    expect(row().reactions).toEqual([]);
    expect(calls.remove).toEqual([[501, '❤️']]);
    expect(calls.add).toEqual([]);
  });

  test('another device getting there first is what the tap drew, so nothing goes back', async () => {
    const add = setup({ answer: () => Promise.reject(refusal('Already reacted')) });
    add.toggle('❤️', add.row());
    await new Promise((r) => setTimeout(r, 0));
    expect(add.row().reactions).toEqual([heart(ME, 'Jo')]);
    expect(add.calls.toasts).toEqual([]);

    const remove = setup({ reactions: [heart(ME, 'Jo')], answer: () => Promise.reject(refusal('Reaction not found', { status: 404 })) });
    remove.toggle('❤️', remove.row());
    await new Promise((r) => setTimeout(r, 0));
    expect(remove.row().reactions).toEqual([]);
    expect(remove.calls.toasts).toEqual([]);
  });

  test('a second tap on the same pill while the first is out sends nothing', async () => {
    const wait = held();
    const { calls, toggle, row } = setup({ answer: () => wait.promise });
    toggle('❤️', row());
    toggle('❤️', row());
    expect(calls.add).toHaveLength(1);
    expect(calls.remove).toHaveLength(0);
    expect(row().reactions).toEqual([heart(ME, 'Jo')]);
    wait.resolve({});
    await new Promise((r) => setTimeout(r, 0));
    // Answered, so the next tap is a real one again.
    toggle('❤️', row());
    expect(calls.remove).toEqual([[501, '❤️']]);
  });

  test('a message still sending says so instead of drawing a pill its echo would drop', () => {
    const { calls, toggle, row } = setup({ id: 'temp-1730250000000' });
    toggle('❤️', row());
    expect(row().reactions).toEqual([]);
    expect(calls.add).toEqual([]);
    expect(calls.toasts).toEqual([['You can react once the message sends.', 'info']]);
  });

  test("the server's echo of the tap finds the drawn pill and adds no second one", () => {
    const state = { directMessages: [{ userId: FRIEND, messages: [{ id: 501, reactions: [heart(ME, 'Jo')] }] }] };
    const subs = {};
    const effect = blockAfter(APP, 'useEffect(() => {\n    const sameReaction');
    // eslint-disable-next-line no-new-func
    new Function('onDmReactionAdded', 'onDmReactionRemoved', 'setDirectMessages', effect)(
      (cb) => { subs.added = cb; return () => {}; },
      (cb) => { subs.removed = cb; return () => {}; },
      setterOn(state, 'directMessages'),
    );
    // The echo carries the id as the server holds it; the drawn row may hold
    // it as the other type.
    subs.added({ dmId: 501, emoji: '❤️', userId: String(ME), userName: 'Jo' });
    expect(state.directMessages[0].messages[0].reactions).toHaveLength(1);
    subs.removed({ dmId: 501, emoji: '❤️', userId: String(ME) });
    expect(state.directMessages[0].messages[0].reactions).toEqual([]);
  });
});
