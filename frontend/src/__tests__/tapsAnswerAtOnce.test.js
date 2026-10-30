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
import React from 'react';
import { render, screen } from '@testing-library/react';

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

// ---------------------------------------------------------------------------
// Unsend, in a plan and in a DM (App.js handleUnsendFlockMessage, handleUnsendDm)
// ---------------------------------------------------------------------------
describe('an unsend fades the bubble at once and only removes it when the server agrees', () => {
  const helpers = `${statementAt(APP, 'const sameContentId = (a, b) =>')}\n${statementAt(APP, 'const markUnsending = (threads, messageId, on) =>')}`;
  const markUnsending = lift(helpers, 'markUnsending', {});
  const mine = (id, text) => ({ id, sender: 'You', text, reactions: [] });

  test('markUnsending marks one row, puts it back exactly, and hands back the same array when nothing moved', () => {
    const before = [{ id: 1, messages: [mine(10, 'a'), mine(11, 'b')] }, { id: 2, messages: [mine(20, 'c')] }];
    const on = markUnsending(before, 11, true);
    expect(on[0].messages[1]).toEqual({ ...mine(11, 'b'), unsending: true });
    expect(on[1]).toBe(before[1]);
    const off = markUnsending(on, 11, false);
    expect(off[0].messages[1]).toEqual(mine(11, 'b'));
    expect('unsending' in off[0].messages[1]).toBe(false);
    expect(markUnsending(before, 999, true)).toBe(before);
    expect(markUnsending(on, 11, true)).toBe(on);
  });

  function flockSetup(answer) {
    const state = { flocks: [{ id: 3, messages: [mine(40, 'door code 4411'), mine(41, 'see you')] }] };
    const calls = { unsend: [], cleared: [], toasts: [] };
    const scope = {
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      setFlocks: setterOn(state, 'flocks'),
      markUnsending,
      unsendFlockMessage: (flockId, messageId) => { calls.unsend.push([flockId, messageId]); return answer(); },
      clearUnsentFlockMessage: (flockId, messageId) => {
        calls.cleared.push([flockId, messageId]);
        setterOn(state, 'flocks')((prev) => prev.map((f) => ({ ...f, messages: f.messages.filter((m) => m.id !== messageId) })));
      },
      showToast: (message, type) => calls.toasts.push([message, type]),
      userMessage,
    };
    const src = `${statementAt(APP, 'const unsendingRef = useRef(')}\n${statementAt(APP, 'const handleUnsendFlockMessage = useCallback(')}`;
    return { state, calls, unsend: lift(src, 'handleUnsendFlockMessage', scope) };
  }

  test('the bubble says Unsending on the tap and leaves when the server confirms', async () => {
    const wait = held();
    const { state, calls, unsend } = flockSetup(() => wait.promise);
    const done = unsend(3, 40);
    expect(state.flocks[0].messages[0].unsending).toBe(true);
    expect(calls.cleared).toEqual([]);
    wait.resolve({ success: true });
    await done;
    expect(state.flocks[0].messages.map((m) => m.id)).toEqual([41]);
    expect(calls.toasts).toEqual([['Message unsent.', undefined]]);
  });

  test('a refusal brings the message back exactly as it was, and says so', async () => {
    const { state, calls, unsend } = flockSetup(() => Promise.reject(crash()));
    await unsend(3, 40);
    expect(state.flocks[0].messages[0]).toEqual(mine(40, 'door code 4411'));
    expect(calls.toasts).toEqual([["That didn't unsend. Try again.", 'error']]);
  });

  test('a message already unsent from another device is cleared, not brought back', async () => {
    const { state, calls, unsend } = flockSetup(() => Promise.reject(refusal('Message not found', { status: 404 })));
    await unsend(3, 40);
    expect(state.flocks[0].messages.map((m) => m.id)).toEqual([41]);
    expect(calls.toasts).toEqual([]);
  });

  test('a second unsend of the same message while the first is out sends nothing', async () => {
    const wait = held();
    const { calls, unsend } = flockSetup(() => wait.promise);
    const first = unsend(3, 40);
    await unsend(3, 40);
    expect(calls.unsend).toEqual([[3, 40]]);
    wait.resolve({});
    await first;
  });

  test('a DM unsend runs the same way, and logs the retraction only once it is real', async () => {
    const state = { directMessages: [{ userId: 4, messages: [mine(70, 'oops'), mine(71, 'ok')] }] };
    const calls = { retractions: [], toasts: [] };
    let answer = () => Promise.reject(refusal('Slow down a moment.', { status: 429 }));
    const scope = {
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      setDirectMessages: setterOn(state, 'directMessages'),
      markUnsending,
      unsendDm: () => answer(),
      noteRetraction: (_ref, entry) => calls.retractions.push(entry),
      retractionsRef: { current: null },
      applyTakedownToDms: (prev, ev) => prev.map((d) => ({ ...d, messages: d.messages.filter((m) => m.id !== ev.contentId) })),
      showToast: (message, type) => calls.toasts.push([message, type]),
      userMessage,
    };
    const src = `${statementAt(APP, 'const unsendingRef = useRef(')}\n${statementAt(APP, 'const handleUnsendDm = useCallback(')}`;
    const unsend = lift(src, 'handleUnsendDm', scope);

    const refused = unsend(70);
    expect(state.directMessages[0].messages[0].unsending).toBe(true);
    await refused;
    expect(state.directMessages[0].messages[0]).toEqual(mine(70, 'oops'));
    expect(calls.retractions).toEqual([]);
    expect(calls.toasts).toEqual([['Slow down a moment.', 'error']]);

    answer = () => Promise.resolve({ success: true });
    await unsend(70);
    expect(state.directMessages[0].messages.map((m) => m.id)).toEqual([71]);
    expect(calls.retractions).toEqual([{ kind: 'dm', messageId: 70 }]);
  });

  test('the row fades, cannot be quoted, and says Unsending in both chats; neither menu offers Unsend twice', () => {
    const StatusLine = require('../components/chat/StatusLine').default;
    const { canQuote } = require('../components/chat/MessageRow');
    render(React.createElement(StatusLine, { status: 'unsending' }));
    expect(screen.getByText('Unsending…')).toBeInTheDocument();
    expect(canQuote({ id: 40, unsending: true })).toBe(false);
    expect(canQuote({ id: 40 })).toBe(true);

    const row = read('components', 'chat', 'MessageRow.js');
    expect(row).toContain('const pending = !!(message && (message.pending || message.unsending));');
    const chat = read('screens', 'ChatDetail.js');
    expect(chat).toContain('if (m.unsending) return <StatusLine status="unsending" />;');
    expect(chat).toMatch(/actionsMessage\.id <= 2147483647 && !actionsMessage\.unsending && \(\s*<button aria-label="Unsend message"/);
    expect(DM).toContain('if (m.unsending) return <StatusLine status="unsending" />;');
    expect(DM).toMatch(/dmActionMessage\.id <= 2147483647 && !dmActionMessage\.unsending && \(\s*<button aria-label="Unsend message"/);
  });
});

// ---------------------------------------------------------------------------
// Declining a plan (App.js handleDeclineFlockInvite, and Join behind it)
// ---------------------------------------------------------------------------
describe('declining a plan moves its card to Declined on the tap', () => {
  const plan = (id, name) => ({ id, name, host: 'Ava', memberStatus: 'invited' });

  function setup({ decline, accept = () => Promise.resolve({}) } = {}) {
    const pending = [plan(1, 'Friday'), plan(2, 'Brunch'), plan(3, 'Karaoke')];
    const state = { pending, declined: [], flocks: [], accepting: null };
    const calls = { declined: [], accepted: [], toasts: [] };
    const scope = {
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      pendingFlockInvites: pending,
      declinedFlockInvites: [],
      setPendingFlockInvites: setterOn(state, 'pending'),
      setDeclinedFlockInvites: setterOn(state, 'declined'),
      declineFlockInvite: (id) => { calls.declined.push(id); return decline(id); },
      showToast: (message, type) => calls.toasts.push([message, type]),
      userMessage,
      // What Join reads.
      acceptingInviteRef: { current: null },
      setAcceptingInviteId: (v) => { state.accepting = v; },
      joinNavRef: { current: null },
      acceptFlockInvite: (id) => { calls.accepted.push(id); return accept(id); },
      storedGuestTokens: () => [],
      meRef: { current: { id: 9, name: 'Jo' } },
      hapticSuccess: () => {},
      setFlocks: setterOn(state, 'flocks'),
      loadFlocks: () => Promise.resolve(),
      openChatAfterJoin: () => {},
      needsEmailVerification: () => false,
      refusedInvitesRef: { current: new Set() },
    };
    const src = [
      statementAt(APP, 'const decliningInvitesRef = useRef('),
      statementAt(APP, 'const handleDeclineFlockInvite = useCallback('),
      statementAt(APP, 'const handleRejoinDeclinedFlock = useCallback('),
    ].join('\n');
    const { decline: tapDecline, rejoin } = lift(src, '{ decline: handleDeclineFlockInvite, rejoin: handleRejoinDeclinedFlock }', scope);
    return { state, calls, tapDecline, rejoin };
  }

  test('the card is in Declined before the server has answered, and stays there when it agrees', async () => {
    const wait = held();
    const { state, calls, tapDecline } = setup({ decline: () => wait.promise });
    const done = tapDecline(2);
    expect(state.pending.map((f) => f.id)).toEqual([1, 3]);
    expect(state.declined).toEqual([{ ...plan(2, 'Brunch'), memberStatus: 'declined' }]);
    wait.resolve({});
    await done;
    expect(state.declined.map((f) => f.id)).toEqual([2]);
    expect(calls.toasts).toEqual([['Invite declined', undefined]]);
  });

  test('a refusal puts the card back where it was and takes it out of Declined', async () => {
    const { state, calls, tapDecline } = setup({ decline: () => Promise.reject(crash()) });
    await tapDecline(2);
    expect(state.pending.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(state.declined).toEqual([]);
    expect(calls.toasts).toEqual([["Couldn't decline that invite. Try again.", 'error']]);
  });

  test('a plan that is gone leaves both lists, in the server\'s words', async () => {
    const { state, calls, tapDecline } = setup({ decline: () => Promise.reject(refusal('This plan has been cancelled.', { status: 409 })) });
    await tapDecline(2);
    expect(state.pending.map((f) => f.id)).toEqual([1, 3]);
    expect(state.declined).toEqual([]);
    expect(calls.toasts).toEqual([['This plan has been cancelled.', undefined]]);
  });

  test('a second tap while the decline is out sends nothing', async () => {
    const wait = held();
    const { calls, tapDecline } = setup({ decline: () => wait.promise });
    const first = tapDecline(2);
    await tapDecline(2);
    expect(calls.declined).toEqual([2]);
    wait.resolve({});
    await first;
  });

  test('Join pressed on the declined row while the decline is still out waits for it', async () => {
    const wait = held();
    const { state, calls, tapDecline, rejoin } = setup({ decline: () => wait.promise });
    const declining = tapDecline(2);
    const joining = rejoin(2);
    await Promise.resolve();
    expect(calls.accepted).toEqual([]);
    expect(state.accepting).toBe(2);
    wait.resolve({});
    await declining;
    await joining;
    expect(calls.accepted).toEqual([2]);
    expect(state.pending.map((f) => f.id)).toEqual([1, 3]);
  });
});
