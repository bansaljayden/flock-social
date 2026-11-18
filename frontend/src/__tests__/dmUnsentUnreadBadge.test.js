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

function run(dms, data) {
  let state = dms;
  const env = {
    noteRetraction: () => {},
    retractionsRef: { current: { log: [] } },
    setDirectMessages: (next) => { state = typeof next === 'function' ? next(state) : next; },
    applyTakedownToDms,
    sameContentId,
  };
  unsentHandler(env)(data);
  return state;
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
});

test('your own unsend never touches the count, and the count never goes below zero', () => {
  const mine = thread({ messages: [{ id: 30, sender: 'Bo' }, { id: 32, sender: 'You' }], unread: 1 });
  expect(run([mine], { messageId: 32, senderId: 9 })[0].unread).toBe(1);
  expect(run([thread({ unread: 0 })], { messageId: 31, senderId: 7 })[0].unread).toBe(0);
});

test('a message this device does not hold changes no count', () => {
  const [row] = run([thread()], { messageId: 99, senderId: 7 });
  expect(row.unread).toBe(2);
});
