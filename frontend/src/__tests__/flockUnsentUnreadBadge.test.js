/**
 * A PLAN MESSAGE UNSENT TAKES ITS UNREAD COUNT WITH IT ONLY IF IT WAS COUNTED.
 *
 * clearUnsentFlockMessage in App.js runs for the live flock_message_unsent
 * event and for your own unsend. The row's unread is a server count (the
 * migration 056 cursor): the other members' messages after your read cursor,
 * which are their newest `unread` messages. It used to subtract one for any
 * removed message that was not yours, so unsending a message you had already
 * read took a newer unread message's badge away. It now subtracts only when
 * the thread held here provably shows which messages were counted: it ends at
 * the server's newest row (historyIsCurrent) and holds at least `unread` of
 * theirs. Otherwise the count is read again (loadFlocks), and the server's
 * count already leaves the unsent message out. The DM twin is
 * dmUnsentUnreadBadge.test.js.
 *
 * The callback is lifted out of App.js by source and run.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test flockUnsentUnreadBadge --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

// Stand-ins with the real ones' contract: the same array back when nothing in
// it was removed.
const sameContentId = (a, b) => a != null && b != null && String(a) === String(b);
const applyTakedownToFlocks = (prev, ev) => {
  let touched = false;
  const next = prev.map((f) => {
    if (String(f.id) !== String(ev.flockId)) return f;
    const msgs = f.messages || [];
    const kept = msgs.filter((m) => !sameContentId(m.id, ev.contentId));
    if (kept.length === msgs.length) return f;
    touched = true;
    return { ...f, messages: kept };
  });
  return touched ? next : prev;
};

function liftClear(env) {
  const head = 'const clearUnsentFlockMessage = useCallback(';
  const at = APP.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const end = APP.indexOf('\n  }, [', at);
  const fn = APP.slice(at + head.length, end + '\n  }'.length);
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return ${fn};`)(...names.map((n) => env[n]));
}

// One app session: the plans held, and the list reads the callback asked for.
// `current`: whether a plan's history is known to end at the server's newest
// row (historyIsCurrent in App.js).
function session(flocks, { current = true } = {}) {
  const s = { flocks, rereads: 0, log: [] };
  const clear = liftClear({
    noteRetraction: (ref, entry) => { ref.current.log.push(entry); },
    retractionsRef: { current: { get log() { return s.log; } } },
    setFlocks: (next) => { s.flocks = typeof next === 'function' ? next(s.flocks) : next; },
    applyTakedownToFlocks,
    sameContentId,
    setFlockReplyingTo: () => {},
    historyIsCurrent: () => current,
    flocksRef: { get current() { return s.flocks; } },
    loadFlocks: () => { s.rereads += 1; },
  });
  s.clear = clear;
  return s;
}

const plan = (over) => ({
  id: 4,
  name: 'Friday',
  unread: 2,
  messages: [
    { id: 30, sender: 'Bo', senderId: 7, text: 'which bar' },
    { id: 31, sender: 'Bo', senderId: 7, text: 'the one on 5th' },
  ],
  ...over,
});

test('their unread message unsent comes off the row\'s count', () => {
  const s = session([plan()]);
  s.clear(4, 31);
  expect(s.flocks[0].messages.map((m) => m.id)).toEqual([30]);
  expect(s.flocks[0].unread).toBe(1);
  expect(s.rereads).toBe(0);
});

test('their message unsent after it was read leaves the newer unread one counted', () => {
  // The cursor is past 30, and 31 is the one counted.
  const s = session([plan({ unread: 1 })]);
  s.clear(4, 30);
  expect(s.flocks[0].messages.map((m) => m.id)).toEqual([31]);
  expect(s.flocks[0].unread).toBe(1);
  expect(s.rereads).toBe(0);
});

test('a plan holding history from before a drop is not trusted to say which message was unread', () => {
  // 30 was read; the socket dropped and 31 arrived unheard. The list read on
  // reconnect kept the cached [30] beside the server's unread 1, which counts
  // 31. Unsending 30 leaves the count alone and reads it again.
  const s = session([plan({ unread: 1, messages: [{ id: 30, sender: 'Bo', senderId: 7 }] })], { current: false });
  s.clear(4, 30);
  expect(s.flocks[0].messages).toEqual([]);
  expect(s.flocks[0].unread).toBe(1);
  expect(s.rereads).toBe(1);
});

test('a current plan holding fewer of their messages than the count is read again too', () => {
  const s = session([plan({ unread: 3, messages: [{ id: 31, sender: 'Bo', senderId: 7 }] })]);
  s.clear(4, 31);
  expect(s.flocks[0].unread).toBe(3);
  expect(s.rereads).toBe(1);
});

test('your own unsend never touches the count and reads nothing, the echo included', () => {
  const s = session([plan({ unread: 1, messages: [{ id: 30, sender: 'Bo', senderId: 7 }, { id: 32, sender: 'You', senderId: 1 }] })]);
  s.clear(4, 32);
  expect(s.flocks[0].unread).toBe(1);
  // The server's echo of the same unsend lands after the confirm cleared it.
  s.clear(4, 32);
  expect(s.flocks[0].unread).toBe(1);
  expect(s.rereads).toBe(0);
});

test('a message this device does not hold changes no count here, and the count is read again once', () => {
  const s = session([plan()]);
  s.clear(4, 99);
  expect(s.flocks[0].unread).toBe(2);
  expect(s.rereads).toBe(1);
  // Read again even where the rendered count is 0: that render can predate
  // the message itself (the batched case below).
  const quiet = session([plan({ unread: 0 })]);
  quiet.clear(4, 99);
  expect(quiet.rereads).toBe(1);
});

test('the plan history read records whether it leaves the plan current', () => {
  const load = APP.slice(APP.indexOf('const loadFlockMessages = useCallback'), APP.indexOf('const prefetchUnreadThread'));
  expect(load).toMatch(/const drops = getSocket\(\)\?\.connected \? socketDropsRef\.current : null;/);
  expect(load).toMatch(/historyCurrentRef\.current\[`flock:\$\{flockId\}`\] = drops;/);
});

test('a message and its unsend landing in one batch leave no phantom badge', () => {
  // React runs queued updates at the next render, so the callback's re-read
  // check sees the plan as last rendered: read before a drop (history not
  // current), nothing unread, 31 not in it yet. 31 arrives and is unsent
  // before React renders; the message's own update (+1) is queued first.
  const rendered = [plan({ unread: 0, messages: [{ id: 30, sender: 'Bo', senderId: 7, text: 'which bar' }] })];
  const queue = [(prev) => prev.map((f) => ({
    ...f, unread: (f.unread || 0) + 1, messages: [...f.messages, { id: 31, sender: 'Bo', senderId: 7, text: 'oops' }],
  }))];
  const log = [];
  let rereads = 0;
  const clear = liftClear({
    noteRetraction: (ref, entry) => { ref.current.log.push(entry); },
    retractionsRef: { current: { log } },
    setFlocks: (next) => { queue.push(next); },
    applyTakedownToFlocks,
    sameContentId,
    setFlockReplyingTo: () => {},
    historyIsCurrent: () => false,
    flocksRef: { current: rendered },
    loadFlocks: () => { rereads += 1; },
  });
  clear(4, 31);
  const after = queue.reduce((s, u) => (typeof u === 'function' ? u(s) : u), rendered);
  expect(after[0].messages.map((m) => m.id)).toEqual([30]);
  expect(rereads).toBe(1);
});