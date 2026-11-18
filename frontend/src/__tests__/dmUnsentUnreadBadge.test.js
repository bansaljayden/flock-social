/**
 * A DM UNSENT BEFORE IT WAS READ TAKES ITS UNREAD COUNT WITH IT.
 *
 * The flock twin (clearUnsentFlockMessage in App.js) subtracts one from the
 * row's server-backed unread count when the message it removes was somebody
 * else's. The DM handler for dm_message_unsent removed the bubble, its quotes
 * and its preview and left the count alone, so the Messages row and the app
 * badge kept counting a message that no longer exists until the next list
 * read. It mirrors the flock twin now.
 *
 * And it subtracts only what it can show was counted. The count is their
 * newest `unread` messages on the server, and a thread held here says which
 * those are only when it ends at the server's newest row (historyIsCurrent)
 * and holds that many of theirs. Otherwise the count is read again. The flock
 * twin keeps the same rule (flockUnsentUnreadBadge.test.js).
 *
 * The handler is lifted out of App.js by source and run.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test dmUnsentUnreadBadge --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

// Stand-ins with the real ones' contract: the same row back when nothing in
// it was removed.
const sameContentId = (a, b) => a != null && b != null && String(a) === String(b);
const applyTakedownToDms = (prev, ev) => {
  let touched = false;
  const next = prev.map((d) => {
    const msgs = d.messages || [];
    const kept = msgs.filter((m) => !sameContentId(m.id, ev.contentId));
    if (kept.length === msgs.length) return d;
    touched = true;
    return { ...d, messages: kept };
  });
  return touched ? next : prev;
};

function unsentHandler(env) {
  const head = 'const unsub = onDmMessageUnsent((data) => {';
  const at = APP.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const end = APP.indexOf('\n    });', at);
  const fn = APP.slice(at + 'const unsub = onDmMessageUnsent('.length, end + '\n    }'.length);
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return ${fn};`)(...names.map((n) => env[n]));
}

// List reads the handler asked for (loadDmConversations, through its ref).
let rereads = 0;

// `current`: whether the thread's history is known to end at the server's
// newest row (historyIsCurrent in App.js: read while the socket was up, with
// no drop since).
function run(dms, data, { current = true } = {}) {
  let state = dms;
  rereads = 0;
  const env = {
    noteRetraction: () => {},
    retractionsRef: { current: { log: [] } },
    setDirectMessages: (next) => { state = typeof next === 'function' ? next(state) : next; },
    applyTakedownToDms,
    sameContentId,
    historyIsCurrent: () => current,
    directMessagesRef: { get current() { return state; } },
    loadDmConversationsRef: { current: () => { rereads += 1; } },
    meRef: { current: { id: ME } },
  };
  unsentHandler(env)(data);
  return state;
}

// The signed-in user; Bo is 7.
const ME = 1;

// React runs queued state updates at the next render, after the handler has
// returned, so the handler's re-read check sees the list as last rendered.
// `queued` are updates already waiting when the unsend lands (the message
// itself, delivered in the same batch).
function runBatched(rendered, queued, data, { current = true } = {}) {
  const queue = [...queued];
  rereads = 0;
  const env = {
    noteRetraction: () => {},
    retractionsRef: { current: { log: [] } },
    setDirectMessages: (next) => { queue.push(next); },
    applyTakedownToDms,
    sameContentId,
    historyIsCurrent: () => current,
    directMessagesRef: { current: rendered },
    loadDmConversationsRef: { current: () => { rereads += 1; } },
    meRef: { current: { id: ME } },
  };
  unsentHandler(env)(data);
  return queue.reduce((s, u) => (typeof u === 'function' ? u(s) : u), rendered);
}

const thread = (over) => ({
  userId: 7,
  name: 'Bo',
  unread: 2,
  lastMessage: 'see you there',
  messages: [
    { id: 30, sender: 'Bo', text: 'are you coming' },
    { id: 31, sender: 'Bo', text: 'see you there' },
  ],
  ...over,
});

test('their message unsent before it was read comes off the row\'s count', () => {
  const [row] = run([thread()], { messageId: 31, senderId: 7 });
  expect(row.messages.map((m) => m.id)).toEqual([30]);
  expect(row.unread).toBe(1);
  expect(rereads).toBe(0);
});

test('a thread holding history from before a drop is not trusted to say which message was unread', () => {
  // 30 was read and the thread closed; the socket dropped and 31 arrived
  // while it was down. The list read on reconnect kept the cached [30] beside
  // the server's unread 1, which counts 31. Unsending 30 must not take 31's
  // count away: the count is read again instead.
  const [row] = run([thread({ unread: 1, messages: [{ id: 30, sender: 'Bo', text: 'are you coming' }] })],
    { messageId: 30, senderId: 7 }, { current: false });
  expect(row.messages).toEqual([]);
  expect(row.unread).toBe(1);
  expect(rereads).toBe(1);
});

test('a current thread holding fewer of their messages than the count is read again too', () => {
  // The count reaches past what this device holds, so the held ones cannot
  // say which of them were counted.
  const [row] = run([thread({ unread: 3, messages: [{ id: 31, sender: 'Bo' }] })], { messageId: 31, senderId: 7 });
  expect(row.unread).toBe(3);
  expect(rereads).toBe(1);
});

test('your own unsend never touches the count, and the count never goes below zero', () => {
  const mine = thread({ messages: [{ id: 30, sender: 'Bo' }, { id: 32, sender: 'You' }], unread: 1 });
  // Your own unsend carries your id as the sender: no count change, no read.
  expect(run([mine], { messageId: 32, senderId: ME })[0].unread).toBe(1);
  expect(rereads).toBe(0);
  expect(run([thread({ unread: 0 })], { messageId: 31, senderId: 7 })[0].unread).toBe(0);
});

test('their message unsent after it was read leaves the newer unread one counted', () => {
  // 30 was read, then 31 arrived while the thread was closed: unread 1, and
  // the one it counts is 31. Unsending 30 takes nothing off it.
  const [row] = run([thread({ unread: 1 })], { messageId: 30, senderId: 7 });
  expect(row.messages.map((m) => m.id)).toEqual([31]);
  expect(row.unread).toBe(1);

  // Your own replies in between do not move which of theirs are counted.
  const mixed = thread({
    unread: 1,
    messages: [{ id: 30, sender: 'Bo' }, { id: 31, sender: 'You' }, { id: 32, sender: 'Bo' }],
  });
  expect(run([mixed], { messageId: 30, senderId: 7 })[0].unread).toBe(1);
  expect(run([mixed], { messageId: 32, senderId: 7 })[0].unread).toBe(0);
});

test('a thread is current only when it was read with the socket up and nothing dropped since', () => {
  // The read notes the drop count it went out at, and only with the socket up.
  const load = APP.slice(APP.indexOf('const loadDmMessages = useCallback'), APP.indexOf('const reloadFlockMessages'));
  expect(load).toMatch(/const drops = getSocket\(\)\?\.connected \? socketDropsRef\.current : null;/);
  expect(load).toMatch(/historyCurrentRef\.current\[`dm:\$\{userId\}`\] = drops;/);
  // Every drop is counted, heard or sampled.
  expect(APP).toMatch(/onSocketDisconnect\(\(\) => \{ socketAliveRef\.current = false; socketDropsRef\.current \+= 1; \}\)/);
  expect(APP).toMatch(/if \(!live\) socketDropsRef\.current \+= 1;/);

  const head = 'const historyIsCurrent = useCallback(';
  const at = APP.indexOf(head);
  const body = APP.slice(at + head.length, APP.indexOf(', []);', at));
  // eslint-disable-next-line no-new-func
  const make = (connected, marks, drops) => new Function('historyCurrentRef', 'socketDropsRef', 'getSocket', `return ${body};`)(
    { current: marks }, { current: drops }, () => ({ connected }),
  );
  expect(make(true, { 'dm:7': 2 }, 2)('dm:7')).toBe(true);
  expect(make(true, { 'dm:7': 1 }, 2)('dm:7')).toBe(false);
  expect(make(false, { 'dm:7': 2 }, 2)('dm:7')).toBe(false);
  expect(make(true, {}, 0)('dm:7')).toBe(false);
});

test('a message of theirs this device does not hold changes no count here, and the count is read again', () => {
  const [row] = run([thread()], { messageId: 99, senderId: 7 });
  expect(row.unread).toBe(2);
  expect(rereads).toBe(1);
  // Read again even where the rendered count is 0: that render can predate
  // the message itself (the batched case below). Never for your own.
  run([thread({ unread: 0 })], { messageId: 99, senderId: 7 });
  expect(rereads).toBe(1);
  run([thread()], { messageId: 99, senderId: ME });
  expect(rereads).toBe(0);
  // A sender with no thread here yet: theirs may be arriving in this batch.
  run([thread()], { messageId: 99, senderId: 9 });
  expect(rereads).toBe(1);
});

test('a message and its unsend landing in one batch leave no phantom badge', () => {
  // The thread was read before a drop (history not current) and shows
  // nothing unread. 31 arrives and is unsent before React renders: the
  // message's own update (+1) is queued first, then the unsend's. The update
  // cannot subtract from a history it cannot trust, so the count must be
  // read again, and the check must not lean on the rendered 0.
  const rendered = [thread({ unread: 0, messages: [{ id: 30, sender: 'Bo', text: 'are you coming' }] })];
  const arrives = (prev) => prev.map((d) => ({
    ...d, unread: (d.unread || 0) + 1, messages: [...d.messages, { id: 31, sender: 'Bo', text: 'oops' }],
  }));
  const [row] = runBatched(rendered, [arrives], { messageId: 31, senderId: 7 }, { current: false });
  expect(row.messages.map((m) => m.id)).toEqual([30]);
  expect(rereads).toBe(1);
});
