// Run: node --test  (from backend/)
//
// THE SENDER'S OWN COPY, AND THE TYPING DOTS A DEAD CONNECTION LEFT BEHIND.
//
// Three things on the socket side of chat, each of which failed quietly:
//
//   1. A FLOCK SEND REACHED ONE DEVICE. send_message echoed with socket.emit,
//      which is the socket that sent, and the member fan-out leaves the sender
//      out on purpose. So the account's other phone or laptop never got its
//      own message until it read the history again. send_dm has echoed to the
//      sender's whole user room since the guest and DM audit; the flock send
//      does too now.
//   2. THE ECHO COULD NOT SAY WHICH SEND IT WAS. The app matched an echo to a
//      bubble on text, type and whether there was a photo, so two sends that
//      look alike (two photos with no caption) could settle the wrong way
//      round when the server finished the later one first. The app now sends
//      its own id for each send and the server hands it back on the sender's
//      copies only. It is validated, never stored and never given to anybody
//      else.
//   3. TYPING NEVER ENDED ON A DROPPED CONNECTION. The app sends the stop from
//      a two second idle timer, which a locked or backgrounded phone never
//      runs, and the disconnect handler sent nothing, so "Maya is typing" sat
//      on everybody else's screen until they left the chat.
//
// No database and no real Socket.io: pool.query is a scripted dispatcher and
// the socket and io are recorders, the same harness as
// __tests__/chatTransportParity.test.js.
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'chat-sender-echo-and-typing-secret';

const pool = require('../config/database');

// Destructured at module load by sockets/handlers.js, so replaced first.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const { registerHandlers, __resetRateLimiters, readClientId } = require('../sockets/handlers');
const blocks = require('../utils/blocks');
const relationships = require('../utils/relationships');

let calls = [];
let routes = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  calls.push({ sql: flat, params });
  for (const [re, rows] of routes) {
    if (re.test(flat)) {
      try {
        return Promise.resolve({ rows: typeof rows === 'function' ? rows(params || []) : rows });
      } catch (err) {
        return Promise.reject(err);
      }
    }
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 140)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

test.after(() => { pool.end?.().catch(() => {}); });

function fakeSocket(id, user) {
  const handlers = new Map();
  const emitted = [];
  const rooms = new Set();
  const socket = {
    id,
    user,
    rooms,
    handshake: null,
    on(event, handler) { handlers.set(event, handler); },
    join(room) { rooms.add(room); },
    leave(room) { rooms.delete(room); },
    emit(event, payload) { emitted.push({ target: 'self', event, payload }); },
    to(room) {
      const op = {
        except() { return op; },
        emit(event, payload) { emitted.push({ target: room, event, payload }); },
      };
      return op;
    },
    disconnect() { socket.disconnected = true; },
    handlers,
    emitted,
  };
  return socket;
}

function fakeIo() {
  const emitted = [];
  return {
    emitted,
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
    to(room) {
      const op = {
        except() { return op; },
        emit(event, payload) { emitted.push({ room, event, payload }); },
      };
      return op;
    },
  };
}

function connect(user = { id: 1, name: 'Ava' }) {
  __resetRateLimiters();
  blocks.__test.blockCache.clear();
  relationships.__test.relationshipCache.clear();
  calls = [];
  routes = [];
  const io = fakeIo();
  const socket = fakeSocket('s1', user);
  registerHandlers(io, socket);
  socket.emitted.length = 0;
  return { io, socket };
}

const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);
// The disconnect's stops are floating promises; one turn of the event loop
// lets every scripted read resolve.
const settle = () => new Promise((r) => setTimeout(r, 20));
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function scriptFlockSend({ members = [2], invisible = [], fanoutFails = false } = {}) {
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 10 }]],
    [/INSERT INTO messages/, (p) => [{
      id: 501, flock_id: p[0], sender_id: p[1], message_text: p[2], message_type: p[3], image_url: p[5],
    }]],
    [/SELECT name FROM flocks WHERE id = \$1/, () => {
      if (fanoutFails) throw new Error('flocks unreadable');
      return [{ name: 'Friday' }];
    }],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/, members.map((id) => ({ user_id: id }))],
    [/FROM user_blocks/, invisible.map((id) => ({ id }))],
  ];
}

// ---------------------------------------------------------------------------
// 1 and 2. The flock echo
// ---------------------------------------------------------------------------

test("a flock send is echoed to the sender's whole account, carrying the client id", async () => {
  const { io, socket } = connect();
  scriptFlockSend();

  await fire(socket, 'send_message', { flockId: 3, message_text: 'ok', client_id: 'c-k3v9a1' });

  const own = io.emitted.filter((e) => e.event === 'new_message' && e.room === 'user:1');
  assert.strictEqual(own.length, 1, 'one copy to the user room reaches every device, this one included');
  assert.strictEqual(own[0].payload.id, 501);
  assert.strictEqual(own[0].payload.status, 'sent');
  assert.strictEqual(own[0].payload.client_id, 'c-k3v9a1');
  assert.ok(!socket.emitted.some((e) => e.event === 'new_message'),
    'not a second copy to the sending socket on top of the room');

  const member = io.emitted.find((e) => e.event === 'new_message' && e.room === 'user:2');
  assert.ok(member, 'the member still gets the message');
  assert.strictEqual(has(member.payload, 'client_id'), false, "a member is never handed the sender's token");
  assert.strictEqual(member.payload.status, undefined);
});

test('a send without a client id is echoed exactly as before', async () => {
  const { io, socket } = connect();
  scriptFlockSend();
  await fire(socket, 'send_message', { flockId: 3, message_text: 'ok' });
  const own = io.emitted.find((e) => e.event === 'new_message' && e.room === 'user:1');
  assert.strictEqual(has(own.payload, 'client_id'), false);
  assert.strictEqual(own.payload.status, 'sent');
});

test('a client id that is not a short safe token is dropped, and the message still sends', async () => {
  for (const bad of ['two words', 'x'.repeat(65), '<b>', '', { id: 'x' }, ['a'], 7, null]) {
    const { io, socket } = connect();
    scriptFlockSend();
    // eslint-disable-next-line no-await-in-loop
    await fire(socket, 'send_message', { flockId: 3, message_text: 'ok', client_id: bad });
    const own = io.emitted.find((e) => e.event === 'new_message' && e.room === 'user:1');
    assert.ok(own, `${JSON.stringify(bad)} cost the message`);
    assert.strictEqual(has(own.payload, 'client_id'), false, `${JSON.stringify(bad)} was echoed`);
  }
});

test('readClientId accepts the shape the app mints and nothing looser', () => {
  assert.strictEqual(readClientId('c-mf3k2x-4q9z1a'), 'c-mf3k2x-4q9z1a');
  assert.strictEqual(readClientId('A_b-9'), 'A_b-9');
  assert.strictEqual(readClientId('x'.repeat(64)), 'x'.repeat(64));
  assert.strictEqual(readClientId('x'.repeat(65)), null);
  assert.strictEqual(readClientId('a b'), null);
  assert.strictEqual(readClientId('a\nb'), null);
  assert.strictEqual(readClientId('a/b'), null);
  assert.strictEqual(readClientId(''), null);
  assert.strictEqual(readClientId(undefined), null);
  assert.strictEqual(readClientId(12345), null);
});

test('when live delivery fails, only the sending socket is answered, with its client id', async () => {
  // The fail-closed path: members read the row from history, and so do the
  // sender's other devices. The socket that sent still settles its bubble.
  const { io, socket } = connect();
  scriptFlockSend({ fanoutFails: true });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'ok', client_id: 'c-1' });

  assert.deepStrictEqual(io.emitted.filter((e) => e.event === 'new_message'), []);
  const own = socket.emitted.find((e) => e.event === 'new_message');
  assert.ok(own);
  assert.strictEqual(own.payload.client_id, 'c-1');
  assert.strictEqual(own.payload.status, undefined, 'no receipt for a send the server could not account for');
});

// ---------------------------------------------------------------------------
// The DM echo carries it too
// ---------------------------------------------------------------------------

function scriptDmSend() {
  routes = [
    [/FROM user_blocks/, []],
    [/SELECT 1 WHERE EXISTS/, [{ '?column?': 1 }]],
    [/SELECT id, name FROM users WHERE id = \$1/, [{ id: 7, name: 'Bo' }]],
    [/INSERT INTO direct_messages/, (p) => [{
      id: 88, sender_id: p[0], receiver_id: p[1], message_text: p[2], message_type: p[3],
    }]],
  ];
}

test("a DM's client id rides on the sender's echo and never on the recipient's copy", async () => {
  const { io, socket } = connect();
  scriptDmSend();

  await fire(socket, 'send_dm', { receiverId: 7, message_text: 'ok', client_id: 'c-dm1' });

  const own = io.emitted.find((e) => e.event === 'new_dm' && e.room === 'user:1');
  assert.ok(own, 'the sender account is echoed');
  assert.strictEqual(own.payload.client_id, 'c-dm1');
  const peer = socket.emitted.find((e) => e.event === 'new_dm' && e.target === 'user:7');
  assert.ok(peer, 'the recipient gets the message');
  assert.strictEqual(has(peer.payload, 'client_id'), false);
});

// ---------------------------------------------------------------------------
// 3. Typing ends with the connection
// ---------------------------------------------------------------------------

function scriptTyping({ members = [2, 3], invisible = [], blockedPair = false, related = true } = {}) {
  routes = [
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/, [{ id: 10 }]],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/,
      members.map((id) => ({ user_id: id }))],
    // isBlockedBetween, asked for a DM pair.
    [/SELECT 1 FROM user_blocks WHERE/, blockedPair ? [{ '?column?': 1 }] : []],
    // getInvisibleUserIds, for the flock fan-out.
    [/FROM user_blocks/, invisible.map((id) => ({ id }))],
    // hasDmRelationship: no for a pair with no friendship and no DM, and no for
    // a banned counterpart.
    [/SELECT 1 WHERE EXISTS/, related ? [{ '?column?': 1 }] : []],
  ];
}

const stops = (io, event) => io.emitted.filter((e) => e.event === event);

test('a socket that drops mid-sentence tells the flock it stopped typing', async () => {
  const { io, socket } = connect();
  scriptTyping();

  await fire(socket, 'typing', 5);
  assert.strictEqual(stops(io, 'user_typing').length, 2, 'both members were told');
  io.emitted.length = 0;

  await fire(socket, 'disconnect');
  await settle();

  const ended = stops(io, 'user_stopped_typing');
  assert.deepStrictEqual(ended.map((e) => e.room).sort(), ['user:2', 'user:3']);
  assert.deepStrictEqual(ended[0].payload, { userId: 1, flockId: 5 }, 'an id and a flock, nothing else');
});

test('a flock where the stop already went is not told again at disconnect', async () => {
  const { io, socket } = connect();
  scriptTyping();

  await fire(socket, 'typing', 5);
  await fire(socket, 'stop_typing', 5);
  io.emitted.length = 0;

  await fire(socket, 'disconnect');
  await settle();
  assert.deepStrictEqual(stops(io, 'user_stopped_typing'), []);
});

test('the disconnect stop keeps the block filter the live events use', async () => {
  const { io, socket } = connect();
  scriptTyping({ invisible: [3] });

  await fire(socket, 'typing', 5);
  io.emitted.length = 0;
  await fire(socket, 'disconnect');
  await settle();
  assert.deepStrictEqual(stops(io, 'user_stopped_typing').map((e) => e.room), ['user:2']);
});

test('a flock the socket never typed in hears nothing when it drops', async () => {
  const { io, socket } = connect();
  scriptTyping();
  await fire(socket, 'disconnect');
  await settle();
  assert.deepStrictEqual(stops(io, 'user_stopped_typing'), []);
});

test('a DM peer who was told "typing" is told it stopped when the socket drops', async () => {
  const { io, socket } = connect();
  scriptTyping();

  await fire(socket, 'dm_typing', { receiverId: 7 });
  assert.ok(socket.emitted.some((e) => e.event === 'dm_user_typing' && e.target === 'user:7'));

  await fire(socket, 'disconnect');
  await settle();
  const ended = stops(io, 'dm_user_stopped_typing');
  assert.deepStrictEqual(ended.map((e) => e.room), ['user:7']);
  assert.deepStrictEqual(ended[0].payload, { userId: 1 });
});

test('a DM stop that already went, or a pair blocked since, gets nothing at disconnect', async () => {
  {
    const { io, socket } = connect();
    scriptTyping();
    await fire(socket, 'dm_typing', { receiverId: 7 });
    await fire(socket, 'dm_stop_typing', { receiverId: 7 });
    io.emitted.length = 0;
    await fire(socket, 'disconnect');
    await settle();
    assert.deepStrictEqual(stops(io, 'dm_user_stopped_typing'), []);
  }
  {
    const { io, socket } = connect();
    scriptTyping();
    await fire(socket, 'dm_typing', { receiverId: 7 });
    // The block lands between the typing and the drop. The cache would keep
    // answering "not blocked" for its TTL, so it is emptied the way the block
    // route's invalidation empties it.
    blocks.__test.blockCache.clear();
    scriptTyping({ blockedPair: true });
    await fire(socket, 'disconnect');
    await settle();
    assert.deepStrictEqual(stops(io, 'dm_user_stopped_typing'), [],
      'the same block gate dm_stop_typing applies while connected');
  }
});

test('a DM peer banned since the typing began gets no stop either, the relationship gate', async () => {
  // dm_stop_typing asks two questions while connected: the block, and the
  // relationship, which is what answers no for a banned peer. The disconnect
  // asked only the first, so a banned account still got an event from here.
  const { io, socket } = connect();
  scriptTyping();
  await fire(socket, 'dm_typing', { receiverId: 7 });
  relationships.__test.relationshipCache.clear();
  scriptTyping({ related: false });
  await fire(socket, 'disconnect');
  await settle();
  assert.deepStrictEqual(stops(io, 'dm_user_stopped_typing'), []);
});
