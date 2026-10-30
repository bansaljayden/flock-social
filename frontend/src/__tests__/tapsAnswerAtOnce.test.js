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
import { render, screen, fireEvent } from '@testing-library/react';

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

// ---------------------------------------------------------------------------
// Friend requests (App.js handleAcceptFriendRequest, handleDeclineFriendRequest,
// handleCancelOutgoingRequest; the buttons in screens/AddFriends.js)
// ---------------------------------------------------------------------------
describe('answering a friend request moves the row on the tap', () => {
  const person = (id, name) => ({ id, name, profile_image_url: null });

  function setup({ answer = () => Promise.resolve({}), verify = () => false } = {}) {
    const pending = [person(1, 'Ava'), person(2, 'Bo'), person(3, 'Cy')];
    const outgoing = [person(7, 'Dee'), person(8, 'Eli')];
    const state = { pending, outgoing, statuses: { 7: 'pending', 8: 'pending' }, friendCount: 4 };
    const calls = { api: [], toasts: [], verify: [] };
    const call = (name) => (id) => { calls.api.push([name, id]); return answer(name, id); };
    const scope = {
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      pendingRequests: pending,
      outgoingRequests: outgoing,
      setPendingRequests: setterOn(state, 'pending'),
      setOutgoingRequests: setterOn(state, 'outgoing'),
      setFriendStatuses: setterOn(state, 'statuses'),
      friendStatusesRef: { current: state.statuses },
      acceptFriendRequest: call('accept'),
      declineFriendRequest: call('decline'),
      removeFriend: call('remove'),
      getUserStats: () => Promise.resolve({ friendCount: 5 }),
      setFriendCount: (n) => { state.friendCount = n; },
      needsEmailVerification: (err, what) => { calls.verify.push(what); return verify(err); },
      showToast: (message, type) => calls.toasts.push([message, type]),
      userMessage,
      withRowAt: lift(statementAt(APP, 'const withRowAt = (list, at, row) =>'), 'withRowAt', {}),
    };
    const src = [
      statementAt(APP, 'const friendRequestBusyRef = useRef('),
      statementAt(APP, 'const handleAcceptFriendRequest = useCallback('),
      statementAt(APP, 'const handleDeclineFriendRequest = useCallback('),
      statementAt(APP, 'const handleCancelOutgoingRequest = useCallback('),
    ].join('\n');
    const handlers = lift(src, '{ accept: handleAcceptFriendRequest, decline: handleDeclineFriendRequest, cancel: handleCancelOutgoingRequest }', scope);
    return { state, calls, ...handlers };
  }

  test('Accept takes the row off on the tap, and says accepted only after the server does', async () => {
    const wait = held();
    const { state, calls, accept } = setup({ answer: () => wait.promise });
    const done = accept(2);
    expect(state.pending.map((r) => r.id)).toEqual([1, 3]);
    expect(calls.toasts).toEqual([]);
    expect(state.statuses[2]).toBeUndefined();
    wait.resolve({});
    await done;
    expect(state.statuses[2]).toBe('accepted');
    expect(calls.toasts).toEqual([['Friend request accepted.', undefined]]);
  });

  test('a refused Accept puts the request back where it was, and the email sheet still gets its turn', async () => {
    const plain = setup({ answer: () => Promise.reject(crash()) });
    await plain.accept(2);
    expect(plain.state.pending.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(plain.calls.toasts).toEqual([["Couldn't accept that request. Try again.", 'error']]);

    const unverified = setup({ answer: () => Promise.reject(refusal('Confirm your email first.', { status: 403 })), verify: () => true });
    await unverified.accept(2);
    expect(unverified.state.pending.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(unverified.calls.verify).toEqual(['add friends']);
    expect(unverified.calls.toasts).toEqual([]);
  });

  test('a request the other person withdrew stays off the list', async () => {
    const { state, calls, accept } = setup({ answer: () => Promise.reject(refusal('Friend request not found', { status: 404 })) });
    await accept(2);
    expect(state.pending.map((r) => r.id)).toEqual([1, 3]);
    expect(calls.toasts).toEqual([['That request was withdrawn.', undefined]]);
  });

  test('Decline takes the row off on the tap and puts it back on a refusal', async () => {
    const wait = held();
    const ok = setup({ answer: () => wait.promise });
    const done = ok.decline(1);
    expect(ok.state.pending.map((r) => r.id)).toEqual([2, 3]);
    wait.resolve({});
    await done;
    expect(ok.state.pending.map((r) => r.id)).toEqual([2, 3]);
    expect(ok.calls.toasts).toEqual([]);

    const refused = setup({ answer: () => Promise.reject(refusal('Slow down a moment.', { status: 429 })) });
    await refused.decline(1);
    expect(refused.state.pending.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(refused.calls.toasts).toEqual([['Slow down a moment.', 'error']]);
  });

  test('Cancel takes the sent request off and its Pending mark with it, and a refusal puts both back', async () => {
    const wait = held();
    const ok = setup({ answer: () => wait.promise });
    const done = ok.cancel(8);
    expect(ok.state.outgoing.map((r) => r.id)).toEqual([7]);
    expect(ok.state.statuses[8]).toBeUndefined();
    wait.resolve({ message: 'Removed' });
    await done;
    expect(ok.state.outgoing.map((r) => r.id)).toEqual([7]);

    const refused = setup({ answer: () => Promise.reject(crash()) });
    await refused.cancel(7);
    expect(refused.state.outgoing.map((r) => r.id)).toEqual([7, 8]);
    expect(refused.state.statuses[7]).toBe('pending');
    expect(refused.calls.toasts).toEqual([["Couldn't cancel that request. Try again.", 'error']]);
  });

  test('a list reload that lands during the wait cannot bring an answered request back', async () => {
    // Add Friends reads both lists each time it opens; one that left the
    // server before the tap can land after the row was taken off.
    const wait = held();
    const { state, accept } = setup({ answer: () => wait.promise });
    const done = accept(2);
    state.pending = [person(1, 'Ava'), person(2, 'Bo'), person(3, 'Cy')];
    wait.resolve({});
    await done;
    expect(state.pending.map((r) => r.id)).toEqual([1, 3]);

    const sent = held();
    const out = setup({ answer: () => sent.promise });
    const cancelled = out.cancel(8);
    out.state.outgoing = [person(7, 'Dee'), person(8, 'Eli')];
    out.state.statuses = { 7: 'pending', 8: 'pending' };
    sent.resolve({ message: 'Removed' });
    await cancelled;
    expect(out.state.outgoing.map((r) => r.id)).toEqual([7]);
    expect(out.state.statuses[8]).toBeUndefined();
  });

  test('a double tap sends one answer', async () => {
    const wait = held();
    const { calls, accept, decline } = setup({ answer: () => wait.promise });
    const first = accept(2);
    await accept(2);
    await decline(2);
    expect(calls.api).toEqual([['accept', 2]]);
    wait.resolve({});
    await first;
  });

  test('the Accept button draws no success tick before the server answers', () => {
    const screenSrc = read('screens', 'AddFriends.js');
    expect(screenSrc).toContain('<button aria-label="Accept friend request" onClick={() => handleAcceptFriendRequest(req.id)}');
    expect(screenSrc).not.toMatch(/confirmClick\(e\); handleAcceptFriendRequest/);
  });
});

// ---------------------------------------------------------------------------
// Pin and unpin in a plan's chat (App.js pinMessage, unpinMessage)
// ---------------------------------------------------------------------------
describe('pinning a message changes the bar on the tap', () => {
  const pin = (id, text) => ({ id, messageId: id, text, messageType: 'text', senderId: 2, senderName: 'Bo', pinnedBy: 2 });
  const msg = (id, text, extra = {}) => ({ id, sender: 'Bo', senderId: 2, text, message_type: 'text', reactions: [], ...extra });

  function setup({ pins = [pin(10, 'door code 4411')], answer } = {}) {
    const state = {
      flocks: [{
        id: 5,
        pins,
        messages: [msg(10, 'door code 4411'), msg(11, 'venmo @bo'), msg(12, '', { sender: 'You', senderId: 9, message_type: 'image' }), msg(13, 'nine?')],
      }],
    };
    const calls = { api: [], toasts: [] };
    const scope = {
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      setFlocks: setterOn(state, 'flocks'),
      flocksRef: { get current() { return state.flocks; } },
      meRef: { current: { id: 9, name: 'Jo' } },
      sameContentId: lift(statementAt(APP, 'const sameContentId = (a, b) =>'), 'sameContentId', {}),
      withRowAt: lift(statementAt(APP, 'const withRowAt = (list, at, row) =>'), 'withRowAt', {}),
      FLOCK_PIN_SEATS: lift(statementAt(APP, 'const FLOCK_PIN_SEATS ='), 'FLOCK_PIN_SEATS', {}),
      applyPins: (flockId, list) => setterOn(state, 'flocks')((prev) => prev.map((f) => (f.id === flockId ? { ...f, pins: list } : f))),
      apiPinFlockMessage: (flockId, id) => { calls.api.push(['pin', id]); return answer('pin', id); },
      apiUnpinFlockMessage: (flockId, id) => { calls.api.push(['unpin', id]); return answer('unpin', id); },
      showToast: (message, type) => calls.toasts.push([message, type]),
      userMessage,
    };
    const src = [
      statementAt(APP, 'const pinBusyRef = useRef('),
      statementAt(APP, 'const editPins = useCallback('),
      statementAt(APP, 'const pinMessage = useCallback('),
      statementAt(APP, 'const unpinMessage = useCallback('),
    ].join('\n');
    const handlers = lift(src, '{ pinIt: pinMessage, unpinIt: unpinMessage }', scope);
    const bar = () => state.flocks[0].pins.map((p) => p.id);
    return { state, calls, bar, ...handlers };
  }

  test('a pin is on the bar before the server answers, built the way the server builds it, then the server\'s list wins', async () => {
    const wait = held();
    const { state, bar, pinIt } = setup({ answer: () => wait.promise });
    const done = pinIt(5, 12);
    expect(bar()).toEqual([10, 12]);
    expect(state.flocks[0].pins[1]).toEqual({ id: 12, messageId: 12, text: '', messageType: 'image', senderId: 9, senderName: 'Jo', pinnedBy: 9 });
    wait.resolve([pin(10, 'door code 4411'), pin(12, ''), pin(13, 'nine?')]);
    await done;
    expect(bar()).toEqual([10, 12, 13]);
  });

  test("a refused pin comes off, in the server's words", async () => {
    const { calls, bar, pinIt } = setup({ answer: () => Promise.reject(refusal('That message is no longer there to pin', { status: 404 })) });
    await pinIt(5, 11);
    expect(bar()).toEqual([10]);
    expect(calls.toasts).toEqual([['That message is no longer there to pin', 'error']]);
  });

  test('a fourth pin is never drawn: the server says why', async () => {
    const full = [pin(10, 'a'), pin(11, 'b'), pin(13, 'c')];
    const wait = held();
    const { calls, bar, pinIt } = setup({ pins: full, answer: () => wait.promise });
    const done = pinIt(5, 12);
    expect(bar()).toEqual([10, 11, 13]);
    expect(calls.api).toEqual([['pin', 12]]);
    wait.reject(refusal('Only 3 messages can be pinned. Unpin one first.', { status: 409 }));
    await done;
    expect(bar()).toEqual([10, 11, 13]);
    expect(calls.toasts).toEqual([['Only 3 messages can be pinned. Unpin one first.', 'error']]);
  });

  test('an unpin leaves the bar on the tap and goes back where it was when refused', async () => {
    const pins = [pin(10, 'a'), pin(11, 'b'), pin(13, 'c')];
    const wait = held();
    const { calls, bar, unpinIt } = setup({ pins, answer: () => wait.promise });
    const done = unpinIt(5, 11);
    expect(bar()).toEqual([10, 13]);
    wait.reject(crash());
    await done;
    expect(bar()).toEqual([10, 11, 13]);
    expect(calls.toasts).toEqual([["That didn't unpin. Try again.", 'error']]);
  });

  test('a second tap on the same message while the first is out sends nothing', async () => {
    const wait = held();
    const { calls, pinIt } = setup({ answer: () => wait.promise });
    const first = pinIt(5, 11);
    await pinIt(5, 11);
    expect(calls.api).toEqual([['pin', 11]]);
    wait.resolve([pin(10, 'a'), pin(11, 'b')]);
    await first;
  });
});

// ---------------------------------------------------------------------------
// Settings switches that write to the server (App.js Toggle,
// handleTogglePhoneDiscovery, answerBirdieConsent)
// ---------------------------------------------------------------------------
describe('a server-backed switch moves on the tap, dims while saving, and snaps back on a refusal', () => {
  const babel = require('@babel/core');
  const toggleSrc = [
    statementAt(APP, 'const PendingSwitchesContext = '),
    statementAt(APP, 'const PHONE_DISCOVERY_SWITCH = '),
    statementAt(APP, 'const BIRDIE_CONSENT_SWITCH = '),
    statementAt(APP, 'const Toggle = ({ on, onChange, label, pendingOn }) =>'),
  ].join('\n');
  const compiled = babel.transformSync(toggleSrc, { presets: ['@babel/preset-react'], babelrc: false, configFile: false }).code;
  const T = lift(compiled, '{ Toggle, PendingSwitchesContext, PHONE_DISCOVERY_SWITCH, BIRDIE_CONSENT_SWITCH }', { React });
  const PROFILE = read('screens', 'ProfileSettings.js');

  test('the two labels are the ones the settings screen draws its switches with', () => {
    expect(PROFILE).toContain(`<Toggle label="${T.PHONE_DISCOVERY_SWITCH}" on={!!phoneDiscoverable}`);
    expect(PROFILE).toContain(`<Toggle label="${T.BIRDIE_CONSENT_SWITCH}" on={birdieConsented}`);
    expect(APP).toMatch(/<PendingSwitchesContext\.Provider value=\{pendingSwitches\}>\s*<ProfileSettings \{\.\.\.profileSettingsProps\} \/>/);
  });

  test('with nothing saving it is the switch it always was', () => {
    const onChange = jest.fn();
    render(React.createElement(T.Toggle, { on: true, onChange, label: 'Crowd alerts' }));
    const sw = screen.getByRole('switch', { name: 'Crowd alerts' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.hasAttribute('aria-busy')).toBe(false);
    expect(sw.style.opacity).toBe('1');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('while its write is out it shows where it is going, dimmed, and a second tap does nothing', () => {
    const onChange = jest.fn();
    const tree = (pending) => React.createElement(T.PendingSwitchesContext.Provider, { value: pending },
      React.createElement(T.Toggle, { on: false, onChange, label: T.PHONE_DISCOVERY_SWITCH }));
    const { rerender } = render(tree({ [T.PHONE_DISCOVERY_SWITCH]: true }));
    const sw = screen.getByRole('switch', { name: T.PHONE_DISCOVERY_SWITCH });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-busy')).toBe('true');
    expect(sw.style.opacity).toBe('0.6');
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
    // Refused: the write ends, `on` never moved, and neither does the switch.
    rerender(tree({}));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.style.opacity).toBe('1');
  });

  test('a caller that can pass the value hands it over as pendingOn', () => {
    render(React.createElement(T.Toggle, { on: true, onChange: () => {}, label: 'Example', pendingOn: false }));
    const sw = screen.getByRole('switch', { name: 'Example' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('aria-busy')).toBe('true');
  });

  function phoneSetup({ discoverable = false, phone = '+12155550100', answer } = {}) {
    const state = { discoverable, to: [], needsNumber: null, error: [] };
    const calls = { api: [], toasts: [] };
    const scope = {
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      phoneDiscoverable: discoverable,
      profilePhone: phone,
      setPhoneDiscoveryTo: (v) => state.to.push(v),
      setPhoneDiscoveryError: (v) => state.error.push(v),
      setPhoneDiscoveryNeedsNumber: (v) => { state.needsNumber = v; },
      setPhoneDiscovery: (next) => { calls.api.push(next); return answer(next); },
      setPhoneDiscoverable: (v) => { state.discoverable = v; },
      showToast: (message, type) => calls.toasts.push([message, type]),
      userMessage,
    };
    const src = `${statementAt(APP, 'const phoneDiscoveryBusyRef = useRef(')}\n${statementAt(APP, 'const handleTogglePhoneDiscovery = useCallback(')}`;
    return { state, calls, flip: lift(src, 'handleTogglePhoneDiscovery', scope) };
  }

  test('Find me by phone: the switch heads on at once and lands on the server\'s answer', async () => {
    const wait = held();
    const { state, calls, flip } = phoneSetup({ answer: () => wait.promise });
    const done = flip();
    expect(state.to).toEqual([true]);
    expect(calls.api).toEqual([true]);
    wait.resolve({ phone_discoverable: true });
    await done;
    expect(state.discoverable).toBe(true);
    expect(state.to).toEqual([true, null]);
    expect(calls.toasts).toEqual([]);
  });

  test('a refusal snaps it back with a toast and writes nothing under it', async () => {
    const { state, calls, flip } = phoneSetup({ discoverable: true, answer: () => Promise.reject(crash()) });
    await flip();
    expect(state.to).toEqual([false, null]);
    expect(state.discoverable).toBe(true);
    expect(calls.toasts).toEqual([["Couldn't change that. Try again.", 'error']]);
    expect(state.error.every((e) => e === '')).toBe(true);
  });

  test('with no number on the account it does not move, and the server says why', async () => {
    const said = refusal('Add your phone number to your profile before turning this on.');
    const { state, calls, flip } = phoneSetup({ phone: '', answer: () => Promise.reject(said) });
    await flip();
    expect(state.to).toEqual([false, null]);
    expect(state.needsNumber).toBe(true);
    expect(calls.toasts).toEqual([['Add your phone number to your profile before turning this on.', 'error']]);
  });

  test('a second tap while the write is out sends nothing', async () => {
    const wait = held();
    const { calls, flip } = phoneSetup({ answer: () => wait.promise });
    const first = flip();
    await flip();
    expect(calls.api).toEqual([true]);
    wait.resolve({ phone_discoverable: true });
    await first;
  });

  function birdieSetup({ panelOpen = false, answer }) {
    const state = { to: [], error: [], patches: [] };
    const calls = { grant: 0, withdraw: 0, toasts: [] };
    const scope = {
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      birdiePanelOpenRef: { current: panelOpen },
      setBirdieConsentTo: (v) => state.to.push(v),
      setBirdieConsentError: (v) => state.error.push(v),
      grantBirdieConsent: () => { calls.grant += 1; return answer(); },
      withdrawBirdieConsent: () => { calls.withdraw += 1; return answer(); },
      onUserPatch: (patch) => state.patches.push(patch),
      showToast: (message, type) => calls.toasts.push([message, type]),
      userMessage,
    };
    const src = `${statementAt(APP, 'const birdieConsentBusyRef = useRef(')}\n${statementAt(APP, 'const answerBirdieConsent = useCallback(')}`;
    return { state, calls, answerIt: lift(src, 'answerBirdieConsent', scope) };
  }

  test('Birdie from Settings: the switch heads off at once, and a refusal is a toast as it snaps back', async () => {
    const { state, calls, answerIt } = birdieSetup({ answer: () => Promise.reject(crash()) });
    const ok = await answerIt(false);
    expect(ok).toBe(false);
    expect(state.to).toEqual([false, null]);
    expect(state.patches).toEqual([]);
    expect(calls.toasts).toEqual([['That did not save. Try again.', 'error']]);
    expect(state.error).toEqual(['']);
  });

  test('Birdie from its own panel: the refusal is said where the question is, not as a toast', async () => {
    const { state, calls, answerIt } = birdieSetup({ panelOpen: true, answer: () => Promise.reject(refusal('Slow down a moment.', { status: 429 })) });
    await answerIt(true);
    expect(state.error).toEqual(['', 'Slow down a moment.']);
    expect(calls.toasts).toEqual([]);
  });

  test("Birdie: a yes lands as the server's own answer, and a double tap sends one", async () => {
    const wait = held();
    const { state, calls, answerIt } = birdieSetup({ answer: () => wait.promise });
    const first = answerIt(true);
    expect(await answerIt(true)).toBe(false);
    expect(calls.grant).toBe(1);
    wait.resolve({ consentedAt: '2026-10-30T20:00:00.000Z' });
    expect(await first).toBe(true);
    expect(state.patches).toEqual([{ birdie_ai_consent_at: '2026-10-30T20:00:00.000Z' }]);
    expect(state.to).toEqual([true, null]);
  });
});
