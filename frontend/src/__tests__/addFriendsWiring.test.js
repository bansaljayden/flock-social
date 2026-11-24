/**
 * ADD FRIENDS, THE STATE BEHIND THE SCREEN (2026-11-23).
 *
 * The handlers were each careful on their own and told nobody else what they
 * learned, so the same person showed as Add, Friends and an open request at
 * once; a friend's code only worked typed exactly; Check again on a big
 * address book sent the same 600 numbers every time and wiped what it had
 * found once the hour's allowance ran out. The handlers live inside
 * FlockAppInner, so each one is lifted out of App.js and run against
 * stand-ins for React's state and the API, the way tapsAnswerAtOnce.test.js
 * runs the request answers. What runs here is the code that ships.
 *
 *   1. applyRelationship, the one writer of where you stand with somebody,
 *      and the screen's reading of a row it has written about.
 *   2. An Add whose answer is an accept, and one that is neither.
 *   3. The code box: any shape of code, Return's own value, your own code, a
 *      refusal for an unconfirmed email.
 *   4. A friend's link: the sheet that asks, and how each answer lands.
 *   5. Contacts: results merge, a refused run keeps them, a big book carries
 *      on where it stopped (through a relaunch too), a refused first run says
 *      nothing about anybody, and an unconfirmed address is told first.
 *   6. The wiring that is only source: the tab Add Friends opens on, the
 *      re-reads, the sign-in note, Decline's Undo, what the QR carries.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false addFriendsWiring
 */
const fs = require('fs');
const path = require('path');
const { friendCodeFrom, friendCodeLink, friendQrText } = require('../lib/friendCode');

const SRC = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(SRC, 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const SCREEN = fs.readFileSync(path.join(SRC, 'screens', 'AddFriends.js'), 'utf8').replace(/\r\n/g, '\n');

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
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`statementAt: \`${marker}\` never ends`);
}

function lift(src, name, scope) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(scope), `${src}\nreturn ${name};`)(...Object.values(scope));
}

const setterOn = (state, key) => (next) => { state[key] = typeof next === 'function' ? next(state[key]) : next; };
const userMessage = (err, fallback) => (err && (err.userFacing || err.isNetworkError || err.sessionExpired) && err.message ? err.message : fallback);
const refusal = (message, extra = {}) => Object.assign(new Error(message), { userFacing: true, status: 400, ...extra });
const tick = async (n = 4) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };

const person = (id, name) => ({ id, name, profile_image_url: null });

// The relationship state and the writer, shared by most of the blocks below.
function relationshipScope(over = {}) {
  const state = { pending: [person(1, 'Ava')], outgoing: [person(7, 'Dee')], statuses: { 1: 'incoming', 7: 'pending' }, friendCount: 4, ...over.state };
  const calls = { stats: 0, toasts: [], api: [], verify: [], remembered: [], forgot: 0 };
  const scope = {
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    setPendingRequests: setterOn(state, 'pending'),
    setOutgoingRequests: setterOn(state, 'outgoing'),
    setFriendStatuses: setterOn(state, 'statuses'),
    friendStatusesRef: { get current() { return state.statuses; } },
    getUserStats: () => { calls.stats += 1; return Promise.resolve({ friendCount: state.friendCount + 1 }); },
    setFriendCount: (n) => { state.friendCount = n; },
    showToast: (message, type) => calls.toasts.push([message, type || 'success']),
    needsEmailVerification: (err, what) => { calls.verify.push(what); return Boolean(err && err.data && err.data.emailVerificationRequired); },
    userMessage,
    ...over.scope,
  };
  const src = [
    statementAt(APP, 'const refreshFriendCount = useCallback('),
    statementAt(APP, 'const relationshipWrittenRef = useRef('),
    statementAt(APP, 'const applyRelationship = useCallback('),
  ].join('\n');
  return { state, calls, scope, src };
}

describe('1. one writer for where you stand with somebody', () => {
  const writer = () => {
    const r = relationshipScope();
    r.apply = lift(r.src, 'applyRelationship', r.scope);
    return r;
  };

  test('a request that arrives is on Requests once, and reads Accept wherever its sender appears', () => {
    const { state, apply } = writer();
    apply(person(2, 'Bo'), 'incoming');
    apply(person(2, 'Bo'), 'incoming');
    expect(state.pending.map((r) => r.id)).toEqual([2, 1]);
    expect(state.statuses[2]).toBe('incoming');
    // The row it draws is the person's, with a time.
    expect(state.pending[0]).toEqual(expect.objectContaining({ id: 2, name: 'Bo', profile_image_url: null }));
    expect(typeof state.pending[0].created_at).toBe('string');
  });

  test('a request you sent is on Sent, and off Requests', () => {
    const { state, apply } = writer();
    apply(person(1, 'Ava'), 'pending');
    expect(state.outgoing.map((r) => r.id)).toEqual([1, 7]);
    expect(state.pending).toEqual([]);
    expect(state.statuses[1]).toBe('pending');
  });

  test('friends: off both lists, and the count is read again', async () => {
    const { state, calls, apply } = writer();
    apply(person(7, 'Dee'), 'accepted');
    apply(person(1, 'Ava'), 'accepted');
    expect(state.pending).toEqual([]);
    expect(state.outgoing).toEqual([]);
    expect(state.statuses).toEqual({ 1: 'accepted', 7: 'accepted' });
    await tick();
    expect(calls.stats).toBe(2);
    expect(state.friendCount).toBe(5);
  });

  test('nothing between you: off both lists, and said as none, not left as a gap', () => {
    const { state, apply } = writer();
    apply(person(7, 'Dee'), 'none');
    expect(state.outgoing).toEqual([]);
    expect(state.statuses[7]).toBe('none');
  });

  // The screen's own reading of a row (screens/AddFriends.js relationOf), for
  // the people whose rows carry the server's word from when a contacts check
  // or a number lookup ran.
  const rowReading = (statuses, pending) => lift(statementAt(SCREEN, 'const relationOf = (user) =>'), 'relationOf', {
    friendStatuses: statuses,
    incomingIds: new Set(pending.map((r) => r.id)),
  });

  test("a request cancelled on Sent reads Add on Contacts too, not the Pending the check saw", async () => {
    const r = relationshipScope();
    Object.assign(r.scope, {
      outgoingRequests: r.state.outgoing,
      friendRequestBusyRef: { current: new Set() },
      cancelFriendRequest: () => Promise.resolve({ status: 'none' }),
      withRowAt: (list) => list,
    });
    const cancel = lift([r.src, statementAt(APP, 'const handleCancelOutgoingRequest = useCallback(')].join('\n'), 'handleCancelOutgoingRequest', r.scope);
    await cancel(7);
    expect(r.state.outgoing).toEqual([]);
    const dee = { id: 7, name: 'Dee', friendship_status: 'pending' };
    expect(rowReading(r.state.statuses, r.state.pending)(dee)).toBe('none');
  });

  test('a request declined, or withdrawn by its sender, stops offering Accept on Contacts', () => {
    const { state, apply } = writer();
    apply(person(1, 'Ava'), 'none');
    const ava = { id: 1, name: 'Ava', friendship_status: 'incoming' };
    // An Accept here would have made them friends: /accept takes a request
    // the caller declined.
    expect(rowReading(state.statuses, state.pending)(ava)).toBe('none');
    // A request that left the Requests list any other way (withdrawn, or the
    // decline's own tap) leaves the same word behind, unless its Accept is
    // still out, whose answer says where they land.
    expect(APP).toMatch(/if \(prev\[id\] === 'incoming' && !asked\.has\(id\) && !answering\(id\)\) edit\(\)\[id\] = 'none';/);
    expect(APP).toMatch(/const answering = \(id\) => friendRequestBusyRef\.current\.has\(id\) \|\| friendRequestBusyRef\.current\.has\(Number\(id\)\);/);
    // And a fresh request from them, or a fresh one of yours, is read as one.
    expect(APP).toMatch(/if \(prev\[r\.id\] !== 'incoming' && prev\[r\.id\] !== 'accepted'\) edit\(\)\[r\.id\] = 'incoming';/);
    expect(APP).toMatch(/for \(const r of requests\) if \(!next\[r\.id\] \|\| next\[r\.id\] === 'none'\) next\[r\.id\] = 'pending';/);
  });

  test('the Requests list keeps the word in step: none once a request has gone, but not while its Accept is out', () => {
    // The effect App.js runs on every change to pendingRequests, run here.
    const at = APP.indexOf('const answering = (id) =>');
    const body = APP.slice(at, APP.indexOf('}, [pendingRequests]);', at));
    const step = (statuses, pending, busy = []) => {
      const state = { statuses };
      // eslint-disable-next-line no-new-func
      new Function('pendingRequests', 'friendRequestBusyRef', 'setFriendStatuses', body)(pending, { current: new Set(busy) }, setterOn(state, 'statuses'));
      return state.statuses;
    };
    // Ava withdrew; Bo's Accept is on its way.
    expect(step({ 1: 'incoming', 2: 'incoming' }, [], [2])).toEqual({ 1: 'none', 2: 'incoming' });
    // A fresh request reads incoming over a none, and a friend stays a friend.
    expect(step({ 3: 'none', 4: 'accepted' }, [person(3, 'Cy'), person(4, 'Di')])).toEqual({ 3: 'incoming', 4: 'accepted' });
  });

  test("a row's own word still counts while nothing about them has been written", () => {
    expect(rowReading({}, [])({ id: 5, name: 'Bo', friendship_status: 'pending' })).toBe('pending');
    expect(rowReading({}, [])({ id: 5, name: 'Bo', friendship_status: null })).toBe('none');
    expect(rowReading({ 5: 'none' }, [person(5, 'Bo')])({ id: 5, name: 'Bo' })).toBe('incoming');
  });

  test('every answer and both socket events go through it', () => {
    expect(APP).toMatch(/applyRelationship\(\{ id: data\.fromUserId, name: data\.fromUserName, profile_image_url: typeof photo === 'string' \? photo : null \}, 'incoming'\);/);
    expect(APP).toMatch(/applyRelationship\(\{ id: data\.fromUserId, name: data\.fromUserName \}, 'accepted'\);/);
    expect(APP).toMatch(/if \(status === 'accepted'\) applyRelationship\(data\.user, 'accepted'\);\s*else if \(!movedSince\) applyRelationship\(data\.user, status === 'pending' \? 'pending' : 'none'\);/);
    // A received request seeds 'incoming' from the list, whichever way the list changed.
    expect(APP).toMatch(/if \(prev\[r\.id\] !== 'incoming' && prev\[r\.id\] !== 'accepted'\) edit\(\)\[r\.id\] = 'incoming';/);
  });
});

describe('2. Add, and what its answer means', () => {
  function send(answer) {
    const r = relationshipScope();
    r.scope.sendFriendRequest = (id) => { r.calls.api.push(id); return answer(id); };
    const fn = lift([
      r.src,
      statementAt(APP, 'const friendRequestBusyRef = useRef('),
      statementAt(APP, 'const handleSendFriendRequest = useCallback('),
    ].join('\n'), 'handleSendFriendRequest', r.scope);
    return { ...r, send: fn };
  }

  test('an Add on somebody who had already asked you is an accept, said in the server\'s words', async () => {
    const { state, calls, send: add } = send(() => Promise.resolve({ status: 'accepted', message: 'You and Ava are now friends!' }));
    await add(person(1, 'Ava'));
    expect(state.pending).toEqual([]);
    expect(state.statuses[1]).toBe('accepted');
    expect(calls.toasts).toEqual([['You and Ava are now friends!', 'success']]);
  });

  test('a request sent lands on Sent', async () => {
    const { state, send: add } = send(() => Promise.resolve({ status: 'pending', message: 'Friend request sent to Bo' }));
    await add(person(2, 'Bo'));
    expect(state.outgoing.map((r) => r.id)).toEqual([2, 7]);
    expect(state.statuses[2]).toBe('pending');
  });

  test('an answer that is neither is said, not shown as Pending', async () => {
    const { state, calls, send: add } = send(() => Promise.resolve({ status: 'declined', message: 'Friend request could not be sent. Try again.' }));
    await add(person(2, 'Bo'));
    expect(state.statuses[2]).toBe('none');
    expect(calls.toasts).toEqual([['Friend request could not be sent. Try again.', 'error']]);
  });

  test('a refusal puts back what the row said, so somebody who asked you still reads Accept', async () => {
    const { state, send: add } = send(() => Promise.reject(refusal('Nope')));
    await add(person(1, 'Ava'));
    expect(state.statuses[1]).toBe('incoming');
  });
});

describe('3. the code box', () => {
  function box({ input = '', mine = 'FLOCK-KP5ETGZF', answer = () => Promise.resolve({ status: 'pending', message: 'Friend request sent to Casey', user: person(5, 'Casey') }), pending = null } = {}) {
    const r = relationshipScope();
    const ui = { field: input, loading: [] };
    r.calls.pendingNow = pending;
    Object.assign(r.scope, {
      addFriendByCode: (code) => { r.calls.api.push(code); return answer(code); },
      friendCodeFrom,
      pendingFriendCode: () => r.calls.pendingNow,
      forgetFriendCode: () => { r.calls.forgot += 1; r.calls.pendingNow = null; },
      rememberFriendCode: (code) => { r.calls.remembered.push(code); },
      friendCodeInput: input,
      myFriendCode: mine,
      setFriendCodeInput: (v) => { ui.field = v; },
      setFriendCodeLoading: (v) => ui.loading.push(v),
    });
    const src = [
      r.src,
      statementAt(APP, 'const sendFriendCode = useCallback('),
      statementAt(APP, 'const friendCodeBusyRef = useRef('),
      statementAt(APP, 'const handleAddByCode = useCallback('),
    ].join('\n');
    return { ...r, ui, ...lift(src, '{ add: handleAddByCode, apply: applyRelationship }', r.scope) };
  }

  test("their accept on the socket, landing before the code's own answer, is not drawn over with Pending", async () => {
    let answer;
    const { state, apply, add } = box({ input: 'FLOCK-NJQXUGUM', answer: () => new Promise((resolve) => { answer = resolve; }) });
    const adding = add();
    await tick();
    apply(person(5, 'Casey'), 'accepted');
    answer({ status: 'pending', message: 'Friend request sent to Casey', user: person(5, 'Casey') });
    await adding;
    expect(state.statuses[5]).toBe('accepted');
    expect(state.outgoing.map((r) => r.id)).toEqual([7]);
  });

  test("Return's own value wins over the one the box published a moment ago", async () => {
    const { calls, add } = box({ input: 'FLOCK-NJQXUGU' });
    await add('flock-njqxugum');
    expect(calls.api).toEqual(['FLOCK-NJQXUGUM']);
  });

  test('a pasted invite, a link or a code without its prefix all send the code', async () => {
    for (const typed of ['Add me on Flock. My code is FLOCK-NJQXUGUM.', 'https://www.flockcorp.com/add/FLOCK-NJQXUGUM', 'njqx ugum']) {
      const { calls, add } = box();
      await add(typed);
      expect([typed, calls.api]).toEqual([typed, ['FLOCK-NJQXUGUM']]);
    }
  });

  test('a tap on Add reads the box, the answer lands on Sent, and the box is emptied', async () => {
    const { state, calls, ui, add } = box({ input: 'FLOCK-NJQXUGUM' });
    await add();
    expect(calls.api).toEqual(['FLOCK-NJQXUGUM']);
    expect(calls.toasts).toEqual([['Friend request sent to Casey', 'success']]);
    expect(ui.field).toBe('');
    expect(ui.loading).toEqual([true, false]);
    expect(state.outgoing.map((r) => r.id)).toEqual([5, 7]);
  });

  test('something that is not a code is said without a request', async () => {
    const { calls, add } = box();
    await add('ADD ME ON FLOCK');
    expect(calls.api).toEqual([]);
    expect(calls.toasts).toEqual([["That isn't a Flock code. A code looks like FLOCK-XXXXXXXX.", 'error']]);
  });

  test('your own code is said here, not spent on a request the server would refuse', async () => {
    const { calls, add } = box();
    await add('kp5etgzf');
    expect(calls.api).toEqual([]);
    expect(calls.toasts).toEqual([["That's your own code.", 'success']]);
  });

  test('an unconfirmed email keeps the code for after the confirmation', async () => {
    const unverified = Object.assign(refusal('Confirm your email to do this.', { status: 403 }), { data: { emailVerificationRequired: true } });
    const { calls, ui, add } = box({ input: 'FLOCK-NJQXUGUM', answer: () => Promise.reject(unverified) });
    await add();
    expect(calls.verify).toEqual(['add friends']);
    expect(calls.remembered).toEqual(['FLOCK-NJQXUGUM']);
    expect(calls.toasts).toEqual([]);
    expect(ui.field).toBe('FLOCK-NJQXUGUM');
  });

  test("the same code waiting from a link is forgotten once it is added", async () => {
    const { calls, add } = box({ pending: 'FLOCK-NJQXUGUM' });
    await add('FLOCK-NJQXUGUM');
    expect(calls.forgot).toBe(1);
  });
});

describe("4. a friend's link", () => {
  // The kept code is one slot, as in lib/friendCode.js: a link remembers its
  // code over the last one's.
  function link({ mine = 'FLOCK-KP5ETGZF', preview = () => Promise.resolve({ user: person(5, 'Casey'), status: 'none' }), verify = false, add = () => Promise.resolve({ ok: true, status: 'pending', message: 'Friend request sent to Casey' }) } = {}) {
    const state = { sheet: null, scanner: true, kept: null };
    const calls = { remembered: [], forgot: 0, verify: [], sent: [], toasts: [] };
    const scope = {
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      friendCodeFrom,
      rememberFriendCode: (code) => { calls.remembered.push(code); state.kept = code; },
      pendingFriendCode: () => state.kept,
      forgetFriendCode: () => { calls.forgot += 1; state.kept = null; },
      setQrScannerOpen: (v) => { state.scanner = v; },
      setFriendLinkSheet: setterOn(state, 'sheet'),
      friendLinkSheetRef: { get current() { return state.sheet; } },
      myFriendCodeRef: { current: mine },
      getFriendByCode: preview,
      // The real one forgets the kept code when its answer is for it.
      sendFriendCode: (code) => { calls.sent.push(code); return add(code).then((r) => { if (state.kept === code) { calls.forgot += 1; state.kept = null; } return r; }); },
      hapticSuccess: () => {},
      showToast: (message, type) => calls.toasts.push([message, type || 'success']),
      userMessage,
      needsEmailVerification: (err, what) => { calls.verify.push(what); return verify; },
    };
    const fns = lift([
      statementAt(APP, 'const friendLinkSeqRef = useRef('),
      statementAt(APP, 'const friendLinkCodeRef = useRef('),
      statementAt(APP, 'const openFriendLink = useCallback('),
      statementAt(APP, 'const sendFriendLink = useCallback('),
    ].join('\n'), '{ open: openFriendLink, send: sendFriendLink }', scope);
    return { state, calls, ...fns };
  }
  const held = () => {
    const out = [];
    return { out, fn: () => new Promise((resolve, reject) => { out.push({ resolve, reject }); }) };
  };

  test('the same link arriving twice is one sheet and one read; Try again asks again', async () => {
    const preview = jest.fn(() => Promise.resolve({ user: person(5, 'Casey'), status: 'none' }));
    const { open } = link({ preview });
    open('FLOCK-NJQXUGUM');
    open('https://www.flockcorp.com/add/FLOCK-NJQXUGUM');
    expect(preview).toHaveBeenCalledTimes(1);
    open('FLOCK-NJQXUGUM', { again: true });
    expect(preview).toHaveBeenCalledTimes(2);
    await tick();
  });

  test('the code is kept, the scanner closes, and the sheet asks who it is before anything is sent', async () => {
    const { state, calls, open } = link();
    open('https://www.flockcorp.com/add/flock-njqxugum');
    expect(calls.remembered).toEqual(['FLOCK-NJQXUGUM']);
    expect(state.scanner).toBe(false);
    expect(state.sheet).toEqual({ code: 'FLOCK-NJQXUGUM', phase: 'loading', user: null, status: null, busy: false });
    await tick();
    expect(state.sheet).toEqual({ code: 'FLOCK-NJQXUGUM', phase: 'ready', user: person(5, 'Casey'), status: 'none', busy: false });
  });

  test('your own code needs no read', () => {
    const preview = jest.fn();
    const { state, open } = link({ preview });
    open('FLOCK-KP5ETGZF');
    expect(preview).not.toHaveBeenCalled();
    expect(state.sheet.status).toBe('self');
  });

  test('a code that names nobody is forgotten and said', async () => {
    const { state, calls, open } = link({ preview: () => Promise.reject(refusal('No user found with this code', { status: 404 })) });
    open('FLOCK-NJQXUGUM');
    await tick();
    expect(state.sheet.phase).toBe('missing');
    expect(calls.forgot).toBe(1);
  });

  test('a dropped connection keeps the code, with Try again', async () => {
    const { state, calls, open } = link({ preview: () => Promise.reject(Object.assign(new Error('offline'), { isNetworkError: true })) });
    open('FLOCK-NJQXUGUM');
    await tick();
    expect(state.sheet.phase).toBe('error');
    expect(calls.forgot).toBe(0);
  });

  test('an unconfirmed address takes the sheet down for the confirm sheet, and keeps the code', async () => {
    const { state, calls, open } = link({ verify: true, preview: () => Promise.reject(refusal('Confirm your email', { status: 403 })) });
    open('FLOCK-NJQXUGUM');
    await tick();
    expect(state.sheet).toBeNull();
    expect(calls.forgot).toBe(0);
    expect(calls.verify).toEqual(['add friends']);
  });

  test('a link that holds no code opens nothing', () => {
    const { state, calls, open } = link();
    open('https://example.com/add/FLOCK-NJQXUGUM');
    expect(state.sheet).toBeNull();
    expect(calls.remembered).toEqual([]);
  });

  test('only the button sends; its answer forgets the code, takes the sheet down and says it', async () => {
    const { state, calls, open, send } = link();
    open('FLOCK-NJQXUGUM');
    await tick();
    expect(calls.sent).toEqual([]);
    await send();
    expect(calls.sent).toEqual(['FLOCK-NJQXUGUM']);
    expect(state.sheet).toBeNull();
    expect(state.kept).toBeNull();
    expect(calls.toasts).toEqual([['Friend request sent to Casey', 'success']]);
  });

  test("a link opened while another's add is out keeps its own sheet and its own code", async () => {
    const adds = held();
    const { state, calls, open, send } = link({ add: adds.fn });
    open('FLOCK-NJQXUGUM');
    await tick();
    const sending = send();
    open('FLOCK-KH7WQTRZ');
    await tick();
    expect(state.sheet).toEqual(expect.objectContaining({ code: 'FLOCK-KH7WQTRZ', phase: 'ready' }));
    adds.out[0].resolve({ ok: true, status: 'pending', message: 'Friend request sent to Casey' });
    await sending;
    // The first one's answer is said; the second one's sheet is still up, and
    // its code still kept for it.
    expect(calls.toasts).toEqual([['Friend request sent to Casey', 'success']]);
    expect(state.sheet).toEqual(expect.objectContaining({ code: 'FLOCK-KH7WQTRZ', phase: 'ready', busy: false }));
    expect(state.kept).toBe('FLOCK-KH7WQTRZ');
    expect(calls.forgot).toBe(0);
    // And a second arrival of that link is still the same sheet, not a second read.
    open('FLOCK-KH7WQTRZ');
    expect(state.sheet.code).toBe('FLOCK-KH7WQTRZ');
  });

  test("a refusal for the first link does not call the second one missing, nor forget its code", async () => {
    const adds = held();
    const { state, calls, open, send } = link({ add: adds.fn });
    open('FLOCK-NJQXUGUM');
    await tick();
    const sending = send();
    open('FLOCK-KH7WQTRZ');
    await tick();
    adds.out[0].reject(refusal('No user found with this code', { status: 404 }));
    await sending;
    expect(state.sheet).toEqual(expect.objectContaining({ code: 'FLOCK-KH7WQTRZ', phase: 'ready' }));
    expect(state.kept).toBe('FLOCK-KH7WQTRZ');
    expect(calls.forgot).toBe(0);
  });

  test("a preview that names nobody, landing after another link opened, leaves that link's code kept", async () => {
    const previews = held();
    const { state, calls, open } = link({ preview: previews.fn });
    open('FLOCK-NJQXUGUM');
    open('FLOCK-KH7WQTRZ');
    previews.out[0].reject(refusal('No user found with this code', { status: 404 }));
    await tick();
    expect(state.kept).toBe('FLOCK-KH7WQTRZ');
    expect(calls.forgot).toBe(0);
    expect(state.sheet).toEqual(expect.objectContaining({ code: 'FLOCK-KH7WQTRZ', phase: 'loading' }));
  });

  test('an unconfirmed address keeps the sheet and the code for after the confirmation', async () => {
    const unverified = Object.assign(refusal('Confirm your email to do this.', { status: 403 }), { data: { emailVerificationRequired: true } });
    const { state, calls, open, send } = link({ verify: true, add: () => Promise.reject(unverified) });
    open('FLOCK-NJQXUGUM');
    await tick();
    await send();
    expect(state.sheet).toEqual(expect.objectContaining({ code: 'FLOCK-NJQXUGUM', phase: 'ready', busy: false }));
    expect(state.kept).toBe('FLOCK-NJQXUGUM');
    expect(calls.toasts).toEqual([]);
  });

  test('the link path reaches add-by-code only through the button', () => {
    // Nothing else in the link's path reaches add-by-code.
    const openSrc = statementAt(APP, 'const openFriendLink = useCallback(');
    expect(openSrc).not.toMatch(/addFriendByCode|sendFriendCode/);
    // Raised for a kept code on the way in, and again once an address is confirmed.
    expect(APP).toMatch(/useEffect\(\(\) => \{\s*const code = pendingFriendCode\(\);\s*if \(code\) openFriendLink\(code\);\s*\}, \[openFriendLink\]\);/);
    expect(APP).toMatch(/if \(!was \|\| emailUnconfirmed \|\| friendLinkSheetRef\.current\) return;/);
  });
});

describe('5. contacts', () => {
  // The real cursor, kept in this page's localStorage the way the app keeps
  // it, so what a relaunch finds is what was really written.
  const CURSOR_KEY = 'flock_contacts_cursor_42';
  const saved = () => JSON.parse(localStorage.getItem(CURSOR_KEY) || 'null');
  afterEach(() => localStorage.clear());

  function sync({ runs, unconfirmed = false, cursor = null, users = [], result = null }) {
    const state = { users, result, loading: [], denied: [], unavailable: [], permission: null, retryAt: null };
    const calls = { syncs: [], verifyPrompt: [], toasts: [] };
    let run = 0;
    const scope = {
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      contactsUsers: state.users,
      contactsResult: state.result,
      emailUnconfirmed: unconfirmed,
      setVerifyNote: () => {},
      setVerifyPrompt: (v) => calls.verifyPrompt.push(v),
      setContactsLoading: (v) => state.loading.push(v),
      setContactsDenied: (v) => state.denied.push(v),
      setContactsUnavailable: (v) => state.unavailable.push(v),
      setContactsPermissionRead: (v) => { state.permission = v; },
      setContactsUsers: setterOn(state, 'users'),
      setContactsResult: setterOn(state, 'result'),
      setContactsRetryAt: (v) => { state.retryAt = v; },
      authUser: { id: 42 },
      syncContacts: (lookup, opts) => { calls.syncs.push(opts); const r = runs[run]; run += 1; return typeof r === 'function' ? r() : Promise.resolve(r); },
      findFriendsByPhone: () => {},
      showToast: (m, t) => calls.toasts.push([m, t]),
      needsEmailVerification: () => false,
      userMessage,
      blockedIdsRef: { current: new Set() },
    };
    const src = [
      statementAt(APP, 'const contactsCursorKey = (userId) =>'),
      statementAt(APP, 'const cursorPerson = (u) =>'),
      statementAt(APP, 'const readContactsCursor = (userId) =>'),
      statementAt(APP, 'const writeContactsCursor = (userId, cursor) =>'),
      statementAt(APP, 'const forgetContactsMatch = (userId, personId) =>'),
      statementAt(APP, 'const contactsRunRef = useRef('),
      statementAt(APP, 'const contactsUsersRef = useRef('),
      statementAt(APP, 'const contactsResultRef = useRef('),
      statementAt(APP, 'const handleSyncContacts = useCallback('),
    ].join('\n');
    const lifted = lift(src, '{ handleSyncContacts, contactsUsersRef, contactsResultRef, readContactsCursor, writeContactsCursor, forgetContactsMatch }', scope);
    if (cursor) lifted.writeContactsCursor(42, cursor);
    // The list and the result as the last render drew them, which is what
    // each render writes into the refs in the app.
    const go = async () => {
      lifted.contactsUsersRef.current = state.users;
      lifted.contactsResultRef.current = state.result;
      await lifted.handleSyncContacts();
    };
    return { state, calls, go, scope, readCursor: lifted.readContactsCursor, writeCursor: lifted.writeContactsCursor, forget: lifted.forgetContactsMatch };
  }
  const result = (over) => ({
    users: [], sent: 600, checked: 600, unreadable: 0, total: 1240, notReached: 640, startBatch: 0, nextBatch: 3,
    answered: 3, throttled: false, retryAt: null, failed: false, contactCount: 900, permission: 'granted', ...over,
  });

  test('an unconfirmed address is told before the prompt, and the book is never read', async () => {
    const { calls, go } = sync({ runs: [], unconfirmed: true });
    await go();
    expect(calls.syncs).toEqual([]);
    expect(calls.verifyPrompt).toEqual(['add friends']);
  });

  test('a big book: counts add up across runs, and the next run starts where the last one stopped', async () => {
    const { calls, state, go } = sync({
      runs: [
        result({ users: [person(9, 'Tobias')] }),
        result({ users: [person(4, 'Maya')], sent: 600, checked: 590, startBatch: 3, nextBatch: 6, notReached: 40 }),
      ],
    });
    await go();
    expect(saved()).toEqual({ nextBatch: 3, total: 1240, sent: 600, checked: 600, users: [person(9, 'Tobias')] });
    expect(state.result).toEqual(expect.objectContaining({ sent: 600, checked: 600, notReached: 640, matched: 1, total: 1240 }));
    await go();
    // The second run was handed the cursor the first one left.
    expect(calls.syncs[1]).toEqual({ cursor: { nextBatch: 3, total: 1240, sent: 600, checked: 600, users: [person(9, 'Tobias')] } });
    expect(state.result).toEqual(expect.objectContaining({ sent: 1200, checked: 1190, unreadable: 10, notReached: 40, matched: 2 }));
    // Matches merge, by name, and go on with the pass.
    expect(state.users.map((u) => u.name)).toEqual(['Maya', 'Tobias']);
    expect(saved().users.map((u) => u.name)).toEqual(['Maya', 'Tobias']);
  });

  test('a pass carried on after a relaunch shows the people its earlier runs found, not nobody', async () => {
    // Run 1, in a session the phone has since closed, found Ana and Bo in the
    // first 600 numbers. The relaunched app holds nothing in memory.
    const { state, go } = sync({
      cursor: { nextBatch: 3, total: 1240, sent: 600, checked: 600, users: [person(1, 'Ana'), { ...person(2, 'Bo'), friendship_status: 'pending' }] },
      runs: [result({ users: [], sent: 600, checked: 600, startBatch: 3, nextBatch: 6, notReached: 40 })],
    });
    expect(state.users).toEqual([]);
    await go();
    expect(state.users.map((u) => u.name)).toEqual(['Ana', 'Bo']);
    expect(state.result).toEqual(expect.objectContaining({ checked: 1200, sent: 1200, notReached: 40, matched: 2 }));
    // Kept as a Flock id, name and photo. Where you stood with them is read
    // fresh, never brought back from the last session.
    expect(saved().users).toEqual([person(1, 'Ana'), person(2, 'Bo')]);
  });

  test('a run the server refused before it checked anything keeps everything it had found', async () => {
    const { state, go } = sync({
      users: [person(9, 'Tobias')],
      result: { checked: 600, total: 1240, sent: 600, unreadable: 0, notReached: 640, throttled: false, retryAt: null, matched: 1 },
      runs: [result({ users: [], sent: 0, checked: 0, answered: 0, throttled: true, retryAt: '2026-11-23T21:40:00.000Z', notReached: 1240, nextBatch: 0 })],
    });
    await go();
    expect(state.users.map((u) => u.name)).toEqual(['Tobias']);
    expect(state.result).toEqual(expect.objectContaining({ checked: 600, matched: 1, throttled: true, retryAt: '2026-11-23T21:40:00.000Z' }));
    expect(saved()).toBeNull();
  });

  test('refused before anything was checked, with nothing found before it: no result at all, only when to try', async () => {
    // "None of these numbers belong to someone..." over "Checked 0 of 500"
    // was a claim about numbers nobody had looked at.
    const { state, go } = sync({
      runs: [result({ users: [], sent: 0, checked: 0, answered: 0, throttled: true, retryAt: '2026-11-23T21:40:00.000Z', total: 500, notReached: 500, nextBatch: 0 })],
    });
    await go();
    expect(state.result).toBeNull();
    expect(state.users).toEqual([]);
    expect(state.retryAt).toBe('2026-11-23T21:40:00.000Z');
    expect(saved()).toBeNull();
  });

  test('refused after a relaunch part way through a pass: what the pass had checked and found, and when it can go on', async () => {
    const cursor = { nextBatch: 3, total: 1240, sent: 600, checked: 595, users: [person(1, 'Ana')] };
    const { state, go } = sync({
      cursor,
      runs: [result({ users: [], sent: 0, checked: 0, answered: 0, throttled: true, retryAt: '2026-11-23T21:40:00.000Z', startBatch: 3, nextBatch: 3, notReached: 640 })],
    });
    await go();
    expect(state.users.map((u) => u.name)).toEqual(['Ana']);
    expect(state.result).toEqual(expect.objectContaining({ checked: 595, sent: 600, unreadable: 5, notReached: 640, matched: 1, throttled: true, retryAt: '2026-11-23T21:40:00.000Z' }));
    expect(state.retryAt).toBeNull();
    // Left as it was, for the next run to carry on from.
    expect(saved()).toEqual(cursor);
  });

  test('somebody blocked is not brought back by the next run of the pass', async () => {
    const { state, scope, go, forget } = sync({
      cursor: { nextBatch: 3, total: 1240, book: 'b1', sent: 600, checked: 600, users: [person(1, 'Ana'), person(2, 'Bo'), person(3, 'Cy')] },
      users: [person(1, 'Ana'), person(2, 'Bo'), person(3, 'Cy')],
      runs: [result({ users: [], book: 'b1', startBatch: 3, nextBatch: 6, notReached: 40 })],
    });
    // Bo blocked here: off the list on screen (handleUserBlocked) and out of
    // the pass's cursor. Cy blocked from another device: known from the
    // blocked list only.
    state.users = state.users.filter((u) => u.id !== 2);
    forget(42, 2);
    expect(saved().users.map((u) => u.name)).toEqual(['Ana', 'Cy']);
    scope.blockedIdsRef.current.add('2');
    scope.blockedIdsRef.current.add('3');
    await go();
    expect(state.users.map((u) => u.name)).toEqual(['Ana']);
    expect(state.result).toEqual(expect.objectContaining({ matched: 1 }));
    expect(saved().users.map((u) => u.name)).toEqual(['Ana']);
    // The block itself takes them out of the cursor.
    expect(statementAt(APP, 'const handleUserBlocked = useCallback(')).toMatch(/forgetContactsMatch\(authUser\?\.id, id\);/);
  });

  test("forgetting somebody the cursor does not hold leaves it as it was, and no cursor is not made one", () => {
    const { writeCursor, readCursor, forget } = sync({ runs: [] });
    forget(42, 2);
    expect(readCursor(42)).toBeNull();
    const cursor = { nextBatch: 3, total: 1240, book: 'b1', sent: 600, checked: 600, users: [person(1, 'Ana')] };
    writeCursor(42, cursor);
    forget(42, 2);
    expect(readCursor(42)).toEqual(cursor);
  });

  test("the cursor keeps the book's print, which is what lets the next run carry on", async () => {
    const { calls, go } = sync({
      runs: [result({ users: [], book: 'k3x9' }), result({ users: [], book: 'k3x9', startBatch: 3, nextBatch: 6, notReached: 40 })],
    });
    await go();
    expect(saved()).toEqual(expect.objectContaining({ nextBatch: 3, total: 1240, book: 'k3x9' }));
    await go();
    expect(calls.syncs[1].cursor).toEqual(expect.objectContaining({ nextBatch: 3, book: 'k3x9' }));
  });

  test('a cursor too big for what this site may keep is kept without the photos', () => {
    const { writeCursor, readCursor } = sync({ runs: [] });
    const realSet = Storage.prototype.setItem;
    let tries = 0;
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(key, value) {
      tries += 1;
      if (tries === 1) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return realSet.call(this, key, value);
    });
    try {
      writeCursor(42, { nextBatch: 3, total: 1240, sent: 600, checked: 600, users: [{ id: 1, name: 'Ana', profile_image_url: 'data:image/png;base64,QQ', friendship_status: 'pending' }] });
    } finally {
      spy.mockRestore();
    }
    expect(readCursor(42)).toEqual({ nextBatch: 3, total: 1240, sent: 600, checked: 600, users: [{ id: 1, name: 'Ana', profile_image_url: null }] });
  });

  test('a finished book clears the cursor, so the next check starts from the top', async () => {
    const { go } = sync({
      cursor: { nextBatch: 1, total: 300, sent: 200, checked: 200, users: [] },
      runs: [result({ total: 300, sent: 100, checked: 100, startBatch: 1, notReached: 0, nextBatch: null })],
    });
    await go();
    expect(saved()).toBeNull();
  });

  test('iOS 18 limited access is kept, so the tab can say how many were shared', async () => {
    const { state, go } = sync({ runs: [result({ permission: 'limited', contactCount: 5, total: 7, sent: 7, checked: 7, notReached: 0, nextBatch: null })] });
    await go();
    expect(state.permission).toBe('limited');
    expect(state.result).toEqual(expect.objectContaining({ permission: 'limited', contactCount: 5 }));
  });

  test('the permission is read, never asked, when the screen opens and on each return', () => {
    const at = APP.indexOf('// THE CONTACTS PERMISSION, READ AND NEVER ASKED.');
    expect(at).toBeGreaterThan(-1);
    const effect = APP.slice(at, APP.indexOf('}, [currentScreen, addFriendsTab, contactsSupported]);', at));
    expect(effect).toMatch(/contactsPermissionState\(\)/);
    expect(effect).not.toMatch(/syncContacts|handleSyncContacts|readContactPhoneNumbers|requestPermissions/);
    expect(effect).toMatch(/document\.addEventListener\('visibilitychange', onVisible\);/);
  });
});

describe('6. the wiring that is only source', () => {
  test('a request in opens Add Friends on Requests, from every door, and old tab ids map to the ones that exist', () => {
    const at = APP.indexOf('const addFriendsOnScreenRef = useRef(false);');
    expect(at).toBeGreaterThan(-1);
    const effect = APP.slice(at, APP.indexOf('}, [currentScreen, requestsTabBadge, addFriendsTab, contactsSupported]);', at));
    expect(effect).toMatch(/React\.useLayoutEffect\(\(\) => \{/);
    expect(effect).toMatch(/if \(requestsTabBadge > 0\) setAddFriendsTab\('requests'\);/);
    expect(effect).toMatch(/else if \(addFriendsTab === 'suggestions' \|\| \(addFriendsTab === 'contacts' && !contactsSupported\)\) setAddFriendsTab\('username'\);/);
    expect(APP).toContain('const requestsTabBadge = pendingRequests.length;');
  });

  test('both request lists are read again on a return to the app and when the socket comes back', () => {
    expect(APP).toMatch(/if \(document\.visibilityState !== 'visible' \|\| Date\.now\(\) - lastReadAt < FRIEND_REQUESTS_REREAD_MS\) return;\s*lastReadAt = Date\.now\(\);\s*refreshFriendRequests\(\);/);
    expect(APP).toContain('const FRIEND_REQUESTS_REREAD_MS = 30000;');
    expect(APP).toMatch(/if \(reconnectTick\) refreshFriendRequests\(\);/);
    // A Sent row that left the list is asked about, not guessed at (section 7).
    expect(APP).toMatch(/getFriendshipStatus\(id\)\s*\.then\(\(s\) => \{[\s\S]{0,160}?if \(s\?\.status === 'accepted'\) applyRelationship/);
  });

  test("a signed-out install says what a friend's link is for, and keeps it through the sign-in", () => {
    expect(APP).toContain("addFriend: 'Sign in and you can add the friend who sent this.',");
    expect(APP).toMatch(/if \(screen === 'addFriend' && waiting\.code\) rememberFriendCode\(waiting\.code\);/);
    expect(APP).toMatch(/: \(pendingFriendCode\(\) \? SIGNED_OUT_LINK_NOTES\.addFriend : ''\)/);
  });

  test("Decline's Undo lives on the row for the window, and no toast can take it away", () => {
    expect(APP).toContain('const DECLINE_UNDO_MS = 5000;');
    expect(APP).toMatch(/decliningRef\.current\.set\(userId, \{ timer: setTimeout\(send, DECLINE_UNDO_MS\), at, request \}\);/);
    // The decline raises no toast of its own, and the toast has no buttons
    // but Dismiss: one slot, so any later toast replaced it, Undo and all.
    const decline = statementAt(APP, 'const handleDeclineFriendRequest = useCallback(');
    expect(decline).not.toMatch(/showToast\('Declined/);
    expect(APP).not.toMatch(/toast\.action|options\.action/);
    // The rows in their window reach the screen, with the Undo.
    const props = APP.slice(APP.indexOf('const addFriendsProps = {'), APP.indexOf('};', APP.indexOf('const addFriendsProps = {')));
    expect(props).toMatch(/\n\s*decliningRequests,\n/);
    expect(props).toMatch(/\n\s*handleUndoDecline,\n/);
  });

  test("the code's link: the server's when it gave one, the site's when not, and kept per account", () => {
    expect(APP).toMatch(/const url = typeof d\.url === 'string' && d\.url \? d\.url : friendCodeLink\(code\);/);
    expect(friendCodeLink('FLOCK-NJQXUGUM')).toBe('https://www.flockcorp.com/add/FLOCK-NJQXUGUM');
  });

  describe("what the QR carries: the server's word, kept with the code", () => {
    function codeRead(answer, { cached = null } = {}) {
      localStorage.clear();
      if (cached) localStorage.setItem('flock_friend_code', JSON.stringify(cached));
      const state = {};
      const set = (key) => (v) => { state[key] = v; };
      const scope = {
        useCallback: (fn) => fn,
        useRef: (v) => ({ current: v }),
        useMemo: (fn) => fn(),
        authUser: { id: 42 },
        FRIEND_CODE_CACHE_KEY: 'flock_friend_code',
        friendCodeFrom,
        friendCodeLink,
        friendQrText,
        getMyFriendCode: () => Promise.resolve(answer),
        myFriendCode: '',
        setMyFriendCode: set('code'),
        setMyFriendCodeUrl: set('url'),
        setMyFriendCodeQr: set('qr'),
        setMyFriendCodeFailed: set('failed'),
      };
      const lifted = lift([
        statementAt(APP, 'const cachedFriendCode = useMemo('),
        statementAt(APP, 'const myFriendCodeRef = useRef('),
        statementAt(APP, 'const friendCodeReadRef = useRef('),
        statementAt(APP, 'const loadMyFriendCode = useCallback('),
      ].join('\n'), '{ cachedFriendCode, loadMyFriendCode }', scope);
      return { state, ...lifted, kept: () => JSON.parse(localStorage.getItem('flock_friend_code') || 'null') };
    }
    const JSON_QR = '{"type":"flock_friend","code":"FLOCK-NJQXUGUM"}';
    const LINK = 'https://www.flockcorp.com/add/FLOCK-NJQXUGUM';
    afterEach(() => localStorage.clear());

    test('the JSON every build reads, until the server sends the link', async () => {
      const before = codeRead({ code: 'FLOCK-NJQXUGUM', url: LINK, qr: JSON_QR });
      await before.loadMyFriendCode();
      expect(before.state).toEqual(expect.objectContaining({ code: 'FLOCK-NJQXUGUM', url: LINK, qr: JSON_QR }));
      expect(before.kept()).toEqual({ userId: 42, code: 'FLOCK-NJQXUGUM', url: LINK, qr: JSON_QR });
      const after = codeRead({ code: 'FLOCK-NJQXUGUM', url: LINK, qr: LINK });
      await after.loadMyFriendCode();
      expect(after.state.qr).toBe(LINK);
    });

    test('a server that says nothing about it, or something that is not this code, gets the JSON', async () => {
      for (const qr of [undefined, '', 'https://www.flockcorp.com/add/FLOCK-KP5ETGZF', 'https://example.com/add/FLOCK-NJQXUGUM']) {
        const read = codeRead({ code: 'FLOCK-NJQXUGUM', url: LINK, qr });
        // eslint-disable-next-line no-await-in-loop
        await read.loadMyFriendCode();
        expect([qr, read.state.qr]).toEqual([qr, JSON_QR]);
      }
    });

    test('the copy on the device draws the same, before the network answers', () => {
      expect(codeRead(null, { cached: { userId: 42, code: 'FLOCK-NJQXUGUM', url: LINK, qr: LINK } }).cachedFriendCode)
        .toEqual({ code: 'FLOCK-NJQXUGUM', url: LINK, qr: LINK });
      // Kept by a build from before the QR's text was kept: the JSON.
      expect(codeRead(null, { cached: { userId: 42, code: 'FLOCK-NJQXUGUM', url: LINK } }).cachedFriendCode.qr).toBe(JSON_QR);
    });
  });

  test('Add Friends has no tab bar under it, and the scanner is not handed to it', () => {
    const props = APP.slice(APP.indexOf('const addFriendsProps = {'), APP.indexOf('};', APP.indexOf('const addFriendsProps = {')));
    expect(props).not.toMatch(/\bBottomNav\b|startQrScanner|stopQrScanner|showQrScanner|qrScannerDivId|qrScanError/);
    for (const name of ['openQrScanner', 'focusCodeFieldRequest', 'myFriendCodeQr', 'handleShareMyCode', 'contactsPermission', 'contactsRetryAt', 'handleOpenAppSettings', 'requestsTabBadge', 'EmailConfirmLine']) {
      expect(props).toMatch(new RegExp(`\\n\\s*${name},\\n`));
    }
  });

  test('the confirm line handed to the screen carries this session\'s resend and re-check', () => {
    expect(APP).toMatch(/const EmailConfirmLine = \(props\) => \{\s*const bound = React\.useContext\(EmailConfirmContext\);\s*return <EmailConfirmLineView \{\.\.\.bound\} \{\.\.\.props\} \/>;/);
    expect(APP).toMatch(/<EmailConfirmContext\.Provider value=\{emailConfirmBound\}>\s*<AddFriends \{\.\.\.addFriendsProps\} \/>/);
  });

  test('Open Settings is the app\'s own page there, and only in the app', () => {
    expect(APP).toContain("try { window.location.href = 'app-settings:'; } catch { /* nothing to open */ }");
    expect(APP).toContain('const handleOpenAppSettings = isNativeShell() ? openAppSettings : undefined;');
  });

  test("a camera this browser cannot open is a warning, and a warning never wears the success tick", () => {
    expect(APP).toMatch(/showToast\("This browser can't open the camera\. Type your friend's code instead\.", 'warning'\);/);
    expect(APP).toMatch(/\{toast\.type === 'error' \|\| toast\.type === 'warning' \? Icons\.alertCircle\('white', 15\) : Icons\.check\('white', 15\)\}/);
  });

  test('the reader the app uses is the shared one', () => {
    expect(friendCodeFrom('njqx ugum')).toBe('FLOCK-NJQXUGUM');
  });
});

describe('7. the request lists, read again', () => {
  // The real reads, the real Add and the real writer, lifted together. The
  // Sent list, the status reads and the Add are held until the test lets
  // each go, so the order things land in is the test's to choose.
  function lists(over = {}) {
    const r = relationshipScope(over);
    const held = { outgoing: [], status: [], send: [] };
    const hold = (into) => new Promise((resolve, reject) => { into.push({ resolve, reject }); });
    Object.assign(r.scope, {
      getPendingRequests: () => Promise.resolve({ requests: [person(1, 'Ava')] }),
      getOutgoingRequests: () => hold(held.outgoing),
      getFriendshipStatus: (id) => { r.calls.api.push(['status', id]); return hold(held.status); },
      sendFriendRequest: (id) => { r.calls.api.push(['send', id]); return hold(held.send); },
      setPendingRequestsError: () => {},
      setOutgoingRequestsLoaded: () => {},
    });
    const fns = lift([
      r.src,
      statementAt(APP, 'const friendRequestBusyRef = useRef('),
      statementAt(APP, 'const decliningRef = useRef('),
      statementAt(APP, 'const handleSendFriendRequest = useCallback('),
      statementAt(APP, 'const pendingReadSeqRef = useRef('),
      statementAt(APP, 'const outgoingReadSeqRef = useRef('),
      statementAt(APP, 'const refreshFriendRequests = useCallback('),
    ].join('\n'), '{ refresh: refreshFriendRequests, add: handleSendFriendRequest, apply: applyRelationship }', r.scope);
    return { ...r, held, ...fns };
  }
  const sentToBo = { status: 'pending', message: 'Friend request sent to Bo' };

  test('a Pending row that left Sent is asked about, and its answer is where it lands', async () => {
    const { state, calls, held, refresh } = lists({ state: { outgoing: [person(7, 'Dee'), person(8, 'Eli')], statuses: { 1: 'incoming', 7: 'pending', 8: 'pending' } } });
    refresh();
    held.outgoing[0].resolve({ requests: [] });
    await tick();
    expect(calls.api).toEqual([['status', '7'], ['status', '8']]);
    expect(state.outgoing).toEqual([]);
    held.status[0].resolve({ status: 'accepted' });
    held.status[1].resolve({ status: 'none' });
    await tick();
    expect(state.statuses[7]).toBe('accepted');
    // Withdrawn from another device: said, so a contacts row's older Pending
    // does not show through.
    expect(state.statuses[8]).toBe('none');
    expect(calls.stats).toBe(1);
  });

  test('an Add still out when the Sent list lands keeps its Pending, and is on Sent once it answers', async () => {
    const { state, calls, held, refresh, add } = lists();
    const adding = add(person(2, 'Bo'));
    expect(state.statuses[2]).toBe('pending');
    refresh();
    held.outgoing[0].resolve({ requests: [person(7, 'Dee')] });
    await tick();
    // Not asked about: its own answer settles it.
    expect(calls.api).toEqual([['send', 2]]);
    expect(state.statuses[2]).toBe('pending');
    held.send[0].resolve(sentToBo);
    await adding;
    expect(state.outgoing.map((r) => r.id)).toEqual([2, 7]);
    expect(state.statuses[2]).toBe('pending');
  });

  test('an Add answered after the list was asked for keeps its row on Sent', async () => {
    const { state, calls, held, refresh, add } = lists();
    refresh();
    const adding = add(person(2, 'Bo'));
    held.send[0].resolve(sentToBo);
    await adding;
    expect(state.outgoing.map((r) => r.id)).toEqual([2, 7]);
    // The server read that list before it stored Bo's request.
    held.outgoing[0].resolve({ requests: [person(7, 'Dee')] });
    await tick();
    expect(state.outgoing.map((r) => r.id)).toEqual([2, 7]);
    expect(state.statuses[2]).toBe('pending');
    expect(calls.api).toEqual([['send', 2]]);
  });

  test('an Add answered before the list was asked for is the list\'s to say', async () => {
    const { state, calls, held, refresh, add } = lists();
    const adding = add(person(2, 'Bo'));
    held.send[0].resolve(sentToBo);
    await adding;
    refresh();
    // Withdrawn from another device since.
    held.outgoing[0].resolve({ requests: [person(7, 'Dee')] });
    await tick();
    expect(state.outgoing.map((r) => r.id)).toEqual([7]);
    expect(calls.api).toEqual([['send', 2], ['status', '2']]);
    held.status[0].resolve({ status: 'none' });
    await tick();
    expect(state.statuses[2]).toBe('none');
  });

  test('a request sent again after a cancel is Pending again when the Sent list says so', async () => {
    const { state, held, refresh, apply } = lists();
    apply(person(2, 'Bo'), 'none');
    refresh();
    // Sent again from another device, after the cancel.
    held.outgoing[0].resolve({ requests: [person(7, 'Dee'), person(2, 'Bo')] });
    await tick();
    expect(state.statuses[2]).toBe('pending');
  });

  test("their accept on the socket, landing before the Add's own answer, stands: a friend is not put back on Sent", async () => {
    const { state, held, add, apply } = lists();
    const adding = add(person(2, 'Bo'));
    apply(person(2, 'Bo'), 'accepted');
    held.send[0].resolve(sentToBo);
    await adding;
    expect(state.statuses[2]).toBe('accepted');
    expect(state.outgoing.map((r) => r.id)).toEqual([7]);
  });

  test('an Add that fails after their accept landed leaves the accept standing, and says nothing about a request not sent', async () => {
    const { state, calls, held, add, apply } = lists();
    const adding = add(person(2, 'Bo'));
    apply(person(2, 'Bo'), 'accepted');
    held.send[0].reject(Object.assign(new Error('The connection dropped.'), { isNetworkError: true }));
    await adding;
    expect(state.statuses[2]).toBe('accepted');
    expect(calls.toasts).toEqual([]);
  });

  test('news about somebody else does not hold back an Add\'s own answer', async () => {
    const { state, held, add, apply } = lists();
    const adding = add(person(2, 'Bo'));
    apply(person(3, 'Cy'), 'incoming');
    held.send[0].resolve(sentToBo);
    await adding;
    expect(state.statuses[2]).toBe('pending');
    expect(state.outgoing.map((r) => r.id)).toEqual([2, 7]);
  });

  test('a request that arrives live while the lists are out is not wiped by them', async () => {
    const { state, held, refresh, apply } = lists();
    refresh();
    apply(person(3, 'Cy'), 'incoming');
    await tick();
    expect(state.pending.map((r) => r.id)).toEqual([3, 1]);
    held.outgoing[0].resolve({ requests: [person(7, 'Dee')] });
    await tick();
    expect(state.statuses[3]).toBe('incoming');
  });

  test('a request cancelled or declined after the lists were asked for stays gone', async () => {
    const { state, held, refresh, apply } = lists({ state: { outgoing: [person(7, 'Dee'), person(8, 'Eli')], statuses: { 1: 'incoming', 7: 'pending', 8: 'pending' } } });
    refresh();
    // Cancel on Eli and Decline on Ava answer through the one writer.
    apply(person(8, 'Eli'), 'none');
    apply(person(1, 'Ava'), 'none');
    await tick();
    expect(state.pending).toEqual([]);
    held.outgoing[0].resolve({ requests: [person(7, 'Dee'), person(8, 'Eli')] });
    await tick();
    expect(state.outgoing.map((r) => r.id)).toEqual([7]);
    expect(state.statuses[8]).toBe('none');
    expect(state.statuses[1]).toBe('none');
    expect(APP).toMatch(/await cancelFriendRequest\(userId\);[\s\S]{0,240}?applyRelationship\(request \|\| \{ id: userId \}, 'none'\);/);
    expect(APP).toMatch(/await declineFriendRequest\(userId\);[\s\S]{0,240}?applyRelationship\(request \|\| \{ id: userId \}, 'none'\);/);
  });
});
