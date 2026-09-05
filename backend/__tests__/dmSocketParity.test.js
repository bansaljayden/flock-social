// Run: node --test  (from backend/)
//
// Round 16 — socket handlers vs. their REST twins.
//
// Every event in sockets/handlers.js has an HTTP counterpart that goes through
// express-validator. The socket path gets none of that for free, and the gaps
// between the two are where the bugs live. This file pins the ones that were
// real:
//
//   1. send_dm took `receiverId` exactly as it arrived. POST /api/dm/:userId
//      refuses a self-DM and coerces the id with `param('userId').isInt()`;
//      the socket did neither, so a self-DM persisted and a whitespace-padded
//      id wrote a row that was delivered to nobody.
//   2. dm_react took `emoji` raw, while POST /api/dm/messages/:id/react
//      enforces a 1-10 character string — and the value is echoed to the
//      counterpart BEFORE the VARCHAR(10) insert can reject it.
//   3. leave_flock and stop_sharing_location each run a database query per
//      event and were the only two such handlers with no rate limit.
//   4. dm_vote_venue accepted an unscreened, unclamped venue name (its two
//      siblings, vote_venue and dm_pin_venue, both clamp and screen) and did
//      its read-then-write toggle across three separate pool checkouts.
//   5. venue vote tallies grouped by (venue_name, venue_id), splitting one
//      venue into several rows whenever members voted for it from different
//      entry points.
//   6. dm_react, dm_remove_react, dm_vote_venue and dm_pin_venue acknowledged
//      the person who acted with `socket.emit`, which reaches the one socket
//      that sent the event. Their REST twins echo to `user:{id}` and reach the
//      account's other devices, so the same action was more complete over the
//      transport the client only falls back to when the socket is down.
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'dm-parity-test-secret';

const pool = require('../config/database');

// Push is destructured at module load by sockets/handlers.js, so it has to be
// replaced BEFORE the handlers are required.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const { registerHandlers, __resetRateLimiters } = require('../sockets/handlers');

// --- harness ---------------------------------------------------------------

let calls = [];
let routes = [];

function dispatch(sql, params) {
  calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, rows] of routes) {
    if (re.test(sql)) {
      return Promise.resolve({ rows: typeof rows === 'function' ? rows(params || []) : rows });
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 100)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      calls.push({ sql: String(sql).trim(), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

test.after(() => { pool.end?.().catch(() => {}); });

function fakeSocket(id, user) {
  const handlers = new Map();
  const emitted = [];
  const rooms = new Set();
  const socket = {
    id,
    user,
    rooms,
    handshake: null, // no handshake => the session watchdog timer stays off
    on(event, handler) { handlers.set(event, handler); },
    join(room) { rooms.add(room); },
    leave(room) { rooms.delete(room); },
    emit(event, payload) { emitted.push({ target: 'self', event, payload }); },
    // `except` records what it was handed, so a test can assert that a
    // broadcast was actually narrowed rather than merely sent.
    to(room) {
      const op = {
        excepted: null,
        except(rooms) { op.excepted = [].concat(rooms); return op; },
        emit(event, payload) { emitted.push({ target: room, event, payload, excepted: op.excepted }); },
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
        excepted: null,
        except(rooms) { op.excepted = [].concat(rooms); return op; },
        emit(event, payload) { emitted.push({ room, event, payload, excepted: op.excepted }); },
      };
      return op;
    },
  };
}

// A socket with the handlers attached, a clean rate limiter and a clean log.
function connect(user = { id: 1, name: 'Ava' }) {
  __resetRateLimiters();
  calls = [];
  routes = [];
  const io = fakeIo();
  const socket = fakeSocket('s1', user);
  registerHandlers(io, socket);
  socket.emitted.length = 0; // drop the join_flock/user-room bookkeeping
  return { io, socket };
}

const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);
const wrote = (table) => calls.filter((c) => new RegExp(`INSERT INTO ${table}`, 'i').test(c.sql));

// ---------------------------------------------------------------------------
// 1. send_dm — receiver identity
// ---------------------------------------------------------------------------

test('send_dm refuses a DM addressed to yourself, exactly as the REST route does', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });

  await fire(socket, 'send_dm', { receiverId: 1, message_text: 'note to self' });

  assert.strictEqual(wrote('direct_messages').length, 0, 'a self-DM must never be persisted');
  assert.strictEqual(calls.length, 0, 'it must bail before touching the database at all');
  assert.strictEqual(socket.emitted.length, 0);
});

test('send_dm refuses an id that only LOOKS numeric to parseInt', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });

  // parseInt('7abc') is 7 and Number.isInteger agrees — which is how sibling
  // handlers used to resolve a malformed id to a real stranger's account.
  await fire(socket, 'send_dm', { receiverId: '7abc', message_text: 'hi' });
  await fire(socket, 'send_dm', { receiverId: { id: 7 }, message_text: 'hi' });
  await fire(socket, 'send_dm', { receiverId: 7.5, message_text: 'hi' });
  await fire(socket, 'send_dm', { receiverId: -7, message_text: 'hi' });
  // Digits all the way down, but far past what a SERIAL column can hold: this
  // used to reach Postgres as an out-of-range int and die there instead of here.
  await fire(socket, 'send_dm', { receiverId: '99999999999999999999', message_text: 'hi' });

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(wrote('direct_messages').length, 0);
});

test('send_dm delivers a numeric-STRING id to the room that id actually names', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    // Round 18: send_dm requires a real relationship, like its REST twin.
    [/SELECT 1 WHERE EXISTS/, [{ '?column?': 1 }]],
    [/SELECT id, name FROM users WHERE id = \$1/, [{ id: 7, name: 'Bo' }]],
    [/INSERT INTO direct_messages/, [{ id: 99, sender_id: 1, receiver_id: 7 }]],
  ];

  // ' 7 ' is the interesting one: Postgres trims when casting to int, so the
  // row was written for user 7 while `user: 7 ` matched no room at all and the
  // message was delivered to nobody.
  await fire(socket, 'send_dm', { receiverId: ' 7 ', message_text: 'hi' });

  assert.strictEqual(wrote('direct_messages').length, 1);
  assert.strictEqual(wrote('direct_messages')[0].params[1], 7, 'the id written must be the integer 7');
  const toReceiver = socket.emitted.find((e) => e.event === 'new_dm' && e.target !== 'self');
  assert.ok(toReceiver, 'the receiver must actually get the message');
  assert.strictEqual(toReceiver.target, 'user:7');
});

test('send_dm refuses a malformed reply target instead of silently dropping the message', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/SELECT 1 WHERE EXISTS/, [{ '?column?': 1 }]],
    [/SELECT id, name FROM users WHERE id = \$1/, [{ id: 7, name: 'Bo' }]],
  ];

  // A non-numeric reply_to_id used to reach the reply lookup and throw there,
  // which the catch turned into "message vanished".
  await fire(socket, 'send_dm', { receiverId: 7, message_text: 'hi', reply_to_id: 'not-an-id' });

  assert.strictEqual(wrote('direct_messages').length, 0);
  assert.ok(
    !calls.some((c) => /FROM direct_messages dm JOIN users/.test(c.sql)),
    'the reply lookup should never be reached with a value it cannot use'
  );
});

test('a valid string reply id is coerced before it reaches the query', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/SELECT 1 WHERE EXISTS/, [{ '?column?': 1 }]],
    [/SELECT id, name FROM users WHERE id = \$1/, [{ id: 7, name: 'Bo' }]],
    [/FROM direct_messages dm JOIN users/, [{ id: 12, message_text: 'earlier', sender_name: 'Bo' }]],
    [/INSERT INTO direct_messages/, [{ id: 99 }]],
  ];

  await fire(socket, 'send_dm', { receiverId: 7, message_text: 'hi', reply_to_id: '12' });

  const lookup = calls.find((c) => /FROM direct_messages dm JOIN users/.test(c.sql));
  assert.strictEqual(lookup.params[0], 12);
  assert.strictEqual(wrote('direct_messages')[0].params[6], 12, 'and the stored reply id is the integer');
});

// ---------------------------------------------------------------------------
// 2. dm_react — emoji shape
// ---------------------------------------------------------------------------

test('dm_react will not relay an emoji the column could never hold', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });

  await fire(socket, 'dm_react', { dmId: 5, emoji: 'x'.repeat(400) });
  await fire(socket, 'dm_react', { dmId: 5, emoji: { toString: () => 'thumbsup' } });
  await fire(socket, 'dm_react', { dmId: 5, emoji: ['thumbsup'] });

  assert.strictEqual(calls.length, 0, 'nothing should reach the database');
  assert.strictEqual(
    socket.emitted.length,
    0,
    'the reaction is echoed to the counterpart BEFORE the insert, so a bad value must be refused up front'
  );
});

test('dm_remove_react applies the same shape rule as dm_react', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });

  await fire(socket, 'dm_remove_react', { dmId: 5, emoji: 'x'.repeat(400) });

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(socket.emitted.length, 0);
});

test('a normal emoji still goes through', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/SELECT sender_id, receiver_id FROM direct_messages/, [{ sender_id: 1, receiver_id: 7 }]],
    [/FROM user_blocks/, []],
    [/INSERT INTO dm_emoji_reactions/, []],
  ];

  await fire(socket, 'dm_react', { dmId: '5', emoji: '🔥' });

  const insert = wrote('dm_emoji_reactions');
  assert.strictEqual(insert.length, 1);
  assert.deepStrictEqual(insert[0].params, [5, 1, '🔥'], 'the id is coerced, the emoji is passed through');
  assert.ok(socket.emitted.some((e) => e.target === 'user:7' && e.event === 'dm_reaction_added'));
});

// ---------------------------------------------------------------------------
// 3. Rate limits on the handlers that query the database
// ---------------------------------------------------------------------------

test('leave_flock cannot be used to run unbounded membership queries', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [[/FROM flock_members/, []]];

  for (let i = 0; i < 200; i++) await fire(socket, 'leave_flock', 42);

  const membershipQueries = calls.filter((c) => /FROM flock_members/.test(c.sql)).length;
  assert.ok(membershipQueries > 0, 'the handler still works');
  assert.ok(
    membershipQueries <= 30,
    `200 events must not become 200 queries (saw ${membershipQueries})`
  );
});

test('a rate-limited leave_flock still detaches from the room', async () => {
  // The meter guards the query and the broadcast, NOT the leave. A refused
  // leave would strand the socket in `flock:{id}` — the room that carries the
  // budget ceiling and every member's bill share.
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [[/FROM flock_members/, []]];

  for (let i = 0; i < 100; i++) await fire(socket, 'join_flock', 42);
  socket.rooms.add('flock:42'); // whatever happened above, it is in the room now

  for (let i = 0; i < 100; i++) await fire(socket, 'leave_flock', 42);

  assert.ok(!socket.rooms.has('flock:42'), 'the socket must always be able to detach');
});

test('stop_sharing_location is metered, but not out of update_location budget', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    // A peer to tell. The stop fans out to `user:{id}` now rather than
    // broadcasting into the flock room, because the room holds only whoever is
    // on that chat screen while the PIN went to every accepted member.
    [/FROM flock_members WHERE flock_id = \$1 AND status/, [{ user_id: 2 }]],
    [/FROM user_blocks/, []],
  ];

  // Spend the whole update_location allowance first, the way a client sharing
  // live location does.
  for (let i = 0; i < 60; i++) await fire(socket, 'update_location', { flockId: 42, lat: 1, lng: 2 });
  socket.emitted.length = 0;
  io.emitted.length = 0;

  await fire(socket, 'stop_sharing_location', { flockId: 42 });

  assert.ok(
    io.emitted.some((e) => e.event === 'member_stopped_sharing'),
    'sharing a bucket with update_location meant the STOP was the event that got dropped, leaving a stale pin on every peer map'
  );
});

test('stop_sharing_location still has a ceiling of its own', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [[/FROM flock_members/, []]];

  for (let i = 0; i < 200; i++) await fire(socket, 'stop_sharing_location', { flockId: 42 });

  const membershipQueries = calls.filter((c) => /FROM flock_members/.test(c.sql)).length;
  assert.ok(membershipQueries > 0);
  assert.ok(membershipQueries <= 30, `saw ${membershipQueries} queries for 200 events`);
});

// ---------------------------------------------------------------------------
// 3b. Images are metered as images
// ---------------------------------------------------------------------------

test('image sends have their own, much tighter ceiling than text sends', async () => {
  // Each accepted image is a PAID Vision call, a row up to Socket.IO's 8MB
  // frame ceiling, and that payload again per recipient. The REST twin is
  // capped at a 1MB body and 300 requests per 15 minutes.
  const { socket } = connect({ id: 1, name: 'Ava' });
  const png = 'data:image/png;base64,' + 'A'.repeat(64);
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM flock_members WHERE flock_id = \$1 AND status/, []],
    [/SELECT name FROM flocks/, [{ name: 'Dinner' }]],
    [/FROM user_blocks/, []],
    [/INSERT INTO messages/, [{ id: 1 }]],
  ];

  for (let i = 0; i < 20; i++) {
    await fire(socket, 'send_message', { flockId: 42, message_type: 'image', image_url: png });
  }

  const stored = wrote('messages').length;
  assert.ok(stored > 0, 'images still send');
  assert.ok(stored <= 10, `expected the image bucket to bite well before 20 (stored ${stored})`);
});

test('the image ceiling does not silence ordinary chat', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  const png = 'data:image/png;base64,' + 'A'.repeat(64);
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM flock_members WHERE flock_id = \$1 AND status/, []],
    [/SELECT name FROM flocks/, [{ name: 'Dinner' }]],
    [/FROM user_blocks/, []],
    [/INSERT INTO messages/, [{ id: 1 }]],
  ];

  for (let i = 0; i < 15; i++) {
    await fire(socket, 'send_message', { flockId: 42, message_type: 'image', image_url: png });
  }
  const afterImages = wrote('messages').length;

  await fire(socket, 'send_message', { flockId: 42, message_text: 'still here' });

  assert.strictEqual(wrote('messages').length, afterImages + 1, 'a text message must not be blocked by the image bucket');
});

// ---------------------------------------------------------------------------
// 4. dm_vote_venue — screening and atomicity
// ---------------------------------------------------------------------------

const dmVoteRoutes = () => [
  [/FROM user_blocks/, []],
  [/FROM friendships/, [{ '?column?': 1 }]], // hasDmRelationship
  [/SELECT id FROM dm_venue_votes/, []],
  [/DELETE FROM dm_venue_votes/, []],
  [/INSERT INTO dm_venue_votes/, []],
  [/pg_advisory_xact_lock/, []],
  [/FROM dm_venue_votes vv/, []],
];

test('dm_vote_venue screens the venue name it is about to persist and broadcast', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = dmVoteRoutes();

  // The word list is shared with vote_venue and dm_pin_venue, which both screen.
  await fire(socket, 'dm_vote_venue', { receiverId: 7, venue_name: 'fuck this place' });

  assert.strictEqual(wrote('dm_venue_votes').length, 0, 'the name must not be stored');
  assert.ok(
    !socket.emitted.some((e) => e.event === 'dm_new_vote'),
    'and must not be broadcast to the counterpart'
  );
});

test('dm_vote_venue clamps a name the column cannot hold instead of throwing on it', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = dmVoteRoutes();

  await fire(socket, 'dm_vote_venue', { receiverId: 7, venue_name: 'A'.repeat(900), venue_id: 'B'.repeat(900) });

  const insert = wrote('dm_venue_votes')[0];
  assert.ok(insert, 'the vote is still recorded');
  assert.strictEqual(insert.params[3].length, 255, 'venue_name clamped to VARCHAR(255)');
  assert.strictEqual(insert.params[4].length, 255, 'venue_id clamped to VARCHAR(255)');
});

test('the dm_vote_venue toggle is one locked transaction, not three loose writes', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = dmVoteRoutes();

  await fire(socket, 'dm_vote_venue', { receiverId: 7, venue_name: "Joe's Bar" });

  const begin = calls.findIndex((c) => /^BEGIN/i.test(c.sql));
  const lock = calls.findIndex((c) => /pg_advisory_xact_lock/.test(c.sql));
  const insert = calls.findIndex((c) => /INSERT INTO dm_venue_votes/.test(c.sql));
  const commit = calls.findIndex((c) => /^COMMIT/i.test(c.sql));

  assert.ok(begin >= 0 && commit > begin, 'the toggle runs in a transaction');
  assert.ok(lock > begin && lock < insert, 'and serializes the pair before reading');
  assert.ok(insert < commit, 'the write commits with the read that decided it');
});

test('dm_vote_venue leaves at most one row per voter on either branch', async () => {
  // Toggling OFF an existing vote must still run the unconditional delete, so
  // no branch can leave a second row behind.
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = dmVoteRoutes();
  routes[2] = [/SELECT id FROM dm_venue_votes/, [{ id: 3 }]]; // already voted for this venue

  await fire(socket, 'dm_vote_venue', { receiverId: 7, venue_name: "Joe's Bar" });

  const deletes = calls.filter((c) => /DELETE FROM dm_venue_votes/.test(c.sql));
  assert.strictEqual(deletes.length, 1);
  assert.ok(!/venue_name/.test(deletes[0].sql), 'the delete clears every vote by this user in the pair');
  assert.strictEqual(wrote('dm_venue_votes').length, 0, 'toggling off does not re-insert');
});

// ---------------------------------------------------------------------------
// 4a. The actor's OTHER devices — an echo belongs to the account, not the socket
// ---------------------------------------------------------------------------
//
// Every other gap in this file is about what the socket transport lets THROUGH
// that REST refuses. This one runs the other way: what the socket transport
// fails to deliver that REST delivers.
//
// An account is several devices on purpose. MAX_SOCKETS_PER_USER is 8 and
// device tokens are stored per device, so the laptop with the web app open and
// the phone in the hand are both live sockets sitting in `user:{id}`. Four
// handlers acknowledged the person who acted with `socket.emit`, which reaches
// exactly one socket: the one that sent the event. Their twins in
// routes/messages.js all echo with `io.to(user:${req.user.id})` and reach every
// one. So a reaction tapped on a phone updated the laptop only when the phone's
// socket was DOWN and the client fell back to HTTP, which is the wrong way
// round — the degraded path was the correct one.
//
// These four pin the echo to the room. The counterpart's copy is unchanged and
// asserted alongside each, because `socket.to(...)` excludes the sending socket
// and `io.to(...)` does not, and confusing the two is how an echo becomes a
// duplicate.

test('dm_react echoes to every device of the reactor, not just the one that tapped', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/SELECT sender_id, receiver_id FROM direct_messages/, [{ sender_id: 1, receiver_id: 7 }]],
    [/FROM user_blocks/, []],
    [/INSERT INTO dm_emoji_reactions/, []],
  ];

  await fire(socket, 'dm_react', { dmId: 5, emoji: '🔥' });

  assert.ok(
    socket.emitted.some((e) => e.target === 'user:7' && e.event === 'dm_reaction_added'),
    'the counterpart still hears about it, over socket.to so this socket is not counted twice'
  );
  const echo = io.emitted.find((e) => e.event === 'dm_reaction_added');
  assert.ok(echo, 'the reactor\'s own copy has to leave through io, which the whole account is in');
  assert.strictEqual(echo.room, 'user:1');
  assert.deepStrictEqual(echo.payload, { dmId: 5, emoji: '🔥', userId: 1, userName: 'Ava' },
    'and it is the same payload POST /api/dm/messages/:id/react sends');
  assert.ok(
    !socket.emitted.some((e) => e.target === 'self'),
    'a self-addressed emit reaches one device and leaves the account\'s others showing the old count'
  );
});

test('dm_remove_react takes the reaction off every device of the person who removed it', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/SELECT sender_id, receiver_id FROM direct_messages/, [{ sender_id: 1, receiver_id: 7 }]],
    [/FROM user_blocks/, []],
    [/DELETE FROM dm_emoji_reactions/, []],
  ];

  await fire(socket, 'dm_remove_react', { dmId: 5, emoji: '🔥' });

  assert.ok(socket.emitted.some((e) => e.target === 'user:7' && e.event === 'dm_reaction_removed'));
  const echo = io.emitted.find((e) => e.event === 'dm_reaction_removed');
  assert.ok(echo, 'the removal is worse than the add if it only lands on one device: the other');
  assert.strictEqual(echo.room, 'user:1');
  assert.deepStrictEqual(echo.payload, { dmId: 5, emoji: '🔥', userId: 1 });
  assert.ok(!socket.emitted.some((e) => e.target === 'self'));
});

test('dm_new_vote reaches the voter\'s other devices, and the two payloads stay different', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  const tally = [{ venue_name: "Joe's Bar", venue_id: null, vote_count: 1, voters: ['Ava'] }];
  routes = dmVoteRoutes();
  routes[6] = [/FROM dm_venue_votes vv/, tally];

  await fire(socket, 'dm_vote_venue', { receiverId: 7, venue_name: "Joe's Bar" });

  const toPeer = socket.emitted.find((e) => e.target === 'user:7' && e.event === 'dm_new_vote');
  const echo = io.emitted.find((e) => e.event === 'dm_new_vote');
  assert.ok(toPeer && echo, 'both sides are told');
  assert.strictEqual(echo.room, 'user:1');
  // `withUserId` names the OTHER end of the conversation and is therefore
  // different in each copy. Only the delivery changed here; if these two ever
  // become the same value, App.js files one of the tallies under the wrong
  // thread again.
  assert.strictEqual(toPeer.payload.withUserId, 1, 'the peer is told the thread is with the voter');
  assert.strictEqual(echo.payload.withUserId, 7, 'and the voter is told it is with the peer');
  assert.deepStrictEqual(echo.payload.votes, tally);
  assert.deepStrictEqual(echo.payload.voter, { userId: 1, name: 'Ava' });
  assert.ok(!socket.emitted.some((e) => e.target === 'self'));
});

test('dm_venue_pinned reaches the pinner\'s other devices, and the two payloads stay different', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/FROM friendships/, [{ '?column?': 1 }]],
    [/INSERT INTO dm_pinned_venues/, []],
  ];

  await fire(socket, 'dm_pin_venue', { receiverId: 7, venue_name: "Joe's Bar" });

  const toPeer = socket.emitted.find((e) => e.target === 'user:7' && e.event === 'dm_venue_pinned');
  const echo = io.emitted.find((e) => e.event === 'dm_venue_pinned');
  assert.ok(toPeer && echo);
  assert.strictEqual(echo.room, 'user:1');
  assert.strictEqual(toPeer.payload.withUserId, 1);
  assert.strictEqual(echo.payload.withUserId, 7);
  assert.strictEqual(echo.payload.venue_name, "Joe's Bar");
  assert.strictEqual(echo.payload.pinned_by, 1);
  assert.ok(!socket.emitted.some((e) => e.target === 'self'));
});

// ---------------------------------------------------------------------------
// 4b. Presence obeys blocks in BOTH directions
// ---------------------------------------------------------------------------

test('going offline is hidden from blocked users, exactly as arriving is', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM user_blocks/, [{ id: 9 }]], // Ava and user 9 have blocked each other
  ];

  await fire(socket, 'join_flock', 42);
  socket.emitted.length = 0;
  await fire(socket, 'leave_flock', 42);

  const offline = socket.emitted.find((e) => e.event === 'member_offline');
  assert.ok(offline, 'the rest of the flock still learns she left');
  assert.ok(
    offline.excepted && offline.excepted.includes('user:9'),
    'member_joined has excluded blocked users since round 4; member_offline announced her by name'
  );
});

test('a departure broadcast is dropped entirely if the block list cannot be read', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM user_blocks/, () => { throw new Error('replica down'); }],
  ];

  await fire(socket, 'leave_flock', 42);

  assert.ok(
    !socket.emitted.some((e) => e.event === 'member_offline'),
    'an unfiltered presence broadcast is worse than a missing one'
  );
});

test('disconnect hides the departure from blocked users too', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    // The accepted roster, for the location-stop fan-out. 9 is blocked and 8
    // is not, so the two halves of the assertion below are distinguishable.
    [/FROM flock_members WHERE flock_id = \$1 AND status/, [{ user_id: 8 }, { user_id: 9 }]],
    [/FROM user_blocks/, [{ id: 9 }]],
  ];

  await fire(socket, 'join_flock', 42);
  await fire(socket, 'disconnect');

  const offline = io.emitted.filter((e) => e.event === 'member_offline');
  assert.strictEqual(offline.length, 1, 'still announced exactly once');
  assert.ok(offline[0].excepted && offline[0].excepted.includes('user:9'));

  // A DROPPED CONNECTION IS THE LIKELIEST WAY A SHARE ENDS. services/socket.js
  // tears the socket down the instant the app is backgrounded on native, so no
  // explicit stop is ever sent. This used to broadcast into the flock room,
  // which holds only the sockets on that chat screen, while the pin itself went
  // to every accepted member - so the people most likely to be holding a stale
  // pin were exactly the ones the stop could not reach.
  const stopped = io.emitted.filter((e) => e.event === 'member_stopped_sharing');
  assert.deepStrictEqual(stopped.map((e) => e.room).sort(), ['user:8'],
    'the stop went to the room rather than to the members holding the pin');
  assert.strictEqual(stopped[0].payload.userId, 1);
  assert.strictEqual(stopped[0].payload.flockId, 42);
});

test('a DM location share ends when the connection does', async () => {
  // The flock share had a disconnect path; the DM share had none. It was
  // symmetric only while both sides stayed connected, and the likelier end of a
  // DM share is that the sharer's connection simply goes - services/socket.js
  // tears the socket down the instant the app is backgrounded on native. Their
  // emit loop stops, no stop is ever sent, and the recipient's dmMemberLocation
  // is only cleared by dm_member_stopped_sharing or by switching threads, so
  // the banner kept saying the other person was sharing indefinitely. Their own
  // React state does not survive a relaunch either, so they never resume and
  // never send the stop themselves.
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/FROM friendships|FROM direct_messages|FROM dm_/, [{ ok: true }]],
    [/[\s\S]*/, [{ ok: true }]],
  ];

  await fire(socket, 'dm_share_location', { receiverId: 2, lat: 40.7, lng: -74.0 });
  assert.ok(socket.emitted.some((e) => e.event === 'dm_location_update'),
    'fixture precondition: the share never went out');
  io.emitted.length = 0;

  await fire(socket, 'disconnect');

  const stopped = io.emitted.filter((e) => e.event === 'dm_member_stopped_sharing');
  assert.deepStrictEqual(stopped.map((e) => e.room), ['user:2'],
    'the peer was left holding a live pin of somebody who is gone');
  assert.strictEqual(stopped[0].payload.userId, 1);
});

test('a DM share that was stopped properly is not announced twice on disconnect', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/[\s\S]*/, [{ ok: true }]],
  ];

  await fire(socket, 'dm_share_location', { receiverId: 2, lat: 40.7, lng: -74.0 });
  await fire(socket, 'dm_stop_sharing_location', { receiverId: 2 });
  io.emitted.length = 0;

  await fire(socket, 'disconnect');
  assert.strictEqual(io.emitted.filter((e) => e.event === 'dm_member_stopped_sharing').length, 0,
    'the disconnect re-announced a share that had already ended');
});

// A second connection for the SAME account on the same io: the phone beside
// the laptop, or the session before a network drop beside the one after it.
// dm_stop_sharing_location answers through socket.to and the disconnect path
// through io.to, so a count of stops has to read both.
function reconnect(io, user, id) {
  const socket = fakeSocket(id, user);
  registerHandlers(io, socket);
  socket.emitted.length = 0;
  return socket;
}
const dmStops = (io, ...sockets) => [io.emitted, ...sockets.map((s) => s.emitted)]
  .flat().filter((e) => e.event === 'dm_member_stopped_sharing');
function dmShareWorld() {
  routes = [
    [/FROM user_blocks/, []],
    [/[\s\S]*/, [{ ok: true }]],
  ];
}

test('a share from two devices ends when the LAST of them does', async () => {
  // dm_member_stopped_sharing is an account-level event: the recipient clears
  // the one pin they hold for this user. The sharing set was per socket, so
  // the phone going to the background told the peer that this user had
  // stopped while the laptop was still sending a position every ten seconds.
  const ava = { id: 1, name: 'Ava' };
  const { io, socket: phone } = connect(ava);
  const laptop = reconnect(io, ava, 's2');
  dmShareWorld();

  await fire(phone, 'dm_share_location', { receiverId: 2, lat: 40.7, lng: -74.0 });
  await fire(laptop, 'dm_share_location', { receiverId: 2, lat: 40.7, lng: -74.0 });

  await fire(phone, 'disconnect');
  assert.strictEqual(dmStops(io, phone, laptop).length, 0,
    'the peer was told the share ended while another device was still feeding it');

  await fire(laptop, 'disconnect');
  const stops = dmStops(io, phone, laptop);
  assert.strictEqual(stops.length, 1, 'the last connection to go announces the end exactly once');
  assert.strictEqual(stops[0].room, 'user:2');
  assert.strictEqual(stops[0].payload.userId, 1);
});

test('a stale socket disconnecting late does not clear the share the new session is sending', async () => {
  // The likelier two-socket case, on one phone: the connection drops, the
  // client reconnects and carries on sharing on the new socket, and the old
  // socket's disconnect only fires when its ping timeout expires, tens of
  // seconds later. That late disconnect used to wipe the pin the live session
  // was still feeding.
  const ava = { id: 1, name: 'Ava' };
  const { io, socket: stale } = connect(ava);
  dmShareWorld();
  await fire(stale, 'dm_share_location', { receiverId: 2, lat: 40.7, lng: -74.0 });

  const live = reconnect(io, ava, 's2');
  await fire(live, 'dm_share_location', { receiverId: 2, lat: 40.71, lng: -74.01 });

  await fire(stale, 'disconnect');
  assert.strictEqual(dmStops(io, stale, live).length, 0,
    'the dead socket cleared a pin the live one is still sending');

  await fire(live, 'dm_share_location', { receiverId: 2, lat: 40.72, lng: -74.02 });
  assert.strictEqual(live.emitted.filter((e) => e.event === 'dm_location_update').length, 2,
    'the live session keeps sharing');

  await fire(live, 'dm_stop_sharing_location', { receiverId: 2 });
  assert.strictEqual(dmStops(io, stale, live).length, 1,
    'the live session ending the share is the one stop');
});

test('a stale disconnect that lands BEFORE the new session shares still ends the share', async () => {
  // The other ordering. Nobody is feeding the pin at that moment, so the peer
  // must be told; the new session then starts a fresh share that ends on its
  // own terms.
  const ava = { id: 1, name: 'Ava' };
  const { io, socket: stale } = connect(ava);
  dmShareWorld();
  await fire(stale, 'dm_share_location', { receiverId: 2, lat: 40.7, lng: -74.0 });
  await fire(stale, 'disconnect');
  assert.strictEqual(dmStops(io, stale).length, 1);

  const live = reconnect(io, ava, 's2');
  await fire(live, 'dm_share_location', { receiverId: 2, lat: 40.7, lng: -74.0 });
  await fire(live, 'disconnect');
  assert.strictEqual(dmStops(io, stale, live).length, 2,
    'each end of a share is announced once, at the moment it actually ends');
});

test('a socket that shares every ten seconds is counted once, so its own stop still lands', async () => {
  // dm_share_location arrives per position tick. Counted per event rather
  // than per socket, five ticks would have needed five stops before the peer
  // heard one.
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  dmShareWorld();
  for (let i = 0; i < 5; i++) {
    await fire(socket, 'dm_share_location', { receiverId: 2, lat: 40.7 + i / 1000, lng: -74.0 });
  }
  await fire(socket, 'dm_stop_sharing_location', { receiverId: 2 });
  assert.strictEqual(dmStops(io, socket).length, 1);
  // And nothing is left behind to be announced again when the socket goes.
  await fire(socket, 'disconnect');
  assert.strictEqual(dmStops(io, socket).length, 1);
});

test('a stop from a socket that never shared still clears a pin nobody is feeding', async () => {
  // The reconnect case in reverse: the share was on the socket that dropped,
  // whose disconnect already announced the end, and the user taps stop on the
  // new socket before its first tick. Refusing that stop would only be right
  // if another socket were still sharing, and none is.
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  dmShareWorld();
  await fire(socket, 'dm_stop_sharing_location', { receiverId: 2 });
  assert.strictEqual(dmStops(io, socket).length, 1);
});

test('one disconnect costs one block lookup, however many flocks were open', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM user_blocks/, []],
  ];

  for (const id of [1, 2, 3, 4, 5]) await fire(socket, 'join_flock', id);
  calls = [];
  await fire(socket, 'disconnect');

  assert.strictEqual(
    calls.filter((c) => /FROM user_blocks/.test(c.sql)).length,
    1,
    'one lookup for the whole disconnect, not one per room'
  );
});

// ---------------------------------------------------------------------------
// 4c. Coordinates that are not coordinates
// ---------------------------------------------------------------------------

test('a coordinate that is not a real coordinate never reaches anyone map', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM flock_members WHERE flock_id = \$1 AND status/, [{ user_id: 2 }]],
    [/FROM user_blocks/, []],
    // Round 24: dm_share_location requires a DM relationship, like every other
    // handler that can put you into someone else's client.
    [/SELECT 1 WHERE EXISTS/, [{ '?column?': 1 }]],
  ];

  // typeof NaN === 'number', so all of these used to pass the old check and
  // arrive at every peer as a JSON `null`.
  for (const [lat, lng] of [[NaN, 0], [0, Infinity], [999, 0], [0, -400]]) {
    await fire(socket, 'update_location', { flockId: 42, lat, lng }); // flock fan-out goes via io
    await fire(socket, 'dm_share_location', { receiverId: 7, lat, lng }); // DM goes via socket.to
  }

  assert.deepStrictEqual(io.emitted, []);
  assert.deepStrictEqual(socket.emitted, []);

  await fire(socket, 'update_location', { flockId: 42, lat: 40.7, lng: -74 });
  await fire(socket, 'dm_share_location', { receiverId: 7, lat: 40.7, lng: -74 });
  assert.ok(io.emitted.some((e) => e.event === 'location_update'), 'real coordinates still go out');
  assert.ok(socket.emitted.some((e) => e.event === 'dm_location_update'));
});

test('DM typing will not put junk into the shared block cache', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [[/FROM user_blocks/, []]];

  await fire(socket, 'dm_typing', { receiverId: 'not-a-user' });
  await fire(socket, 'dm_typing', { receiverId: { id: 7 } });
  await fire(socket, 'dm_stop_typing', { receiverId: [7] });
  await fire(socket, 'dm_stop_sharing_location', { receiverId: '7abc' });

  assert.strictEqual(calls.length, 0, 'nothing should reach utils/blocks or the database');
  assert.strictEqual(socket.emitted.length, 0);
});

// ---------------------------------------------------------------------------
// 4d. A relayed state transition is delivered once, not on demand
// ---------------------------------------------------------------------------

test('one pending friend request cannot be rung into a victim client repeatedly', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/FROM friendships/, [{ '?column?': 1 }]], // the request really is pending
  ];

  for (let i = 0; i < 50; i++) await fire(socket, 'friend_request_sent', { toUserId: 9 });

  const rings = io.emitted.filter((e) => e.event === 'friend_request_received');
  assert.strictEqual(rings.length, 1, 'the row stays pending until answered, so the row check alone gated nothing');
  assert.strictEqual(rings[0].room, 'user:9');
});

test('the relay ceiling survives a reconnect, because a socket id is free', async () => {
  const first = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/FROM friendships/, [{ '?column?': 1 }]],
  ];
  await fire(first.socket, 'friend_request_sent', { toUserId: 9 });
  assert.strictEqual(first.io.emitted.filter((e) => e.event === 'friend_request_received').length, 1);

  // A brand new connection for the same account, built WITHOUT going through
  // `connect` — which resets every process-global counter, the way a restart
  // would. Reconnecting is free; the pair ceiling must not be per-socket state.
  const io2 = fakeIo();
  const s2 = fakeSocket('s2', { id: 1, name: 'Ava' });
  registerHandlers(io2, s2);
  await fire(s2, 'friend_request_sent', { toUserId: 9 });

  assert.strictEqual(
    io2.emitted.filter((e) => e.event === 'friend_request_received').length,
    0,
    'reconnecting must not buy another delivery'
  );
});

test('an accepted answer is relayed once, not forever', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/FROM friendships/, [{ '?column?': 1 }]],
  ];

  for (let i = 0; i < 30; i++) {
    await fire(socket, 'friend_request_response', { toUserId: 9, action: 'accepted' });
  }

  assert.strictEqual(
    io.emitted.filter((e) => e.event === 'friend_request_responded').length,
    1,
    "'accepted' is terminal, so the row check can never stop relaying it"
  );
});

test('a flood is refused before it costs a database query', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/FROM friendships/, [{ '?column?': 1 }]],
  ];

  await fire(socket, 'friend_request_sent', { toUserId: 9 });
  calls = [];
  for (let i = 0; i < 20; i++) await fire(socket, 'friend_request_sent', { toUserId: 9 });

  assert.strictEqual(calls.length, 0, 'the pair ceiling is checked before the block and row lookups');
});

// ---------------------------------------------------------------------------
// 4e. One event, one shape, whichever transport produced it
// ---------------------------------------------------------------------------

test('socket-originated flock events carry the integer id the client matches on', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/SELECT creator_id FROM flocks/, [{ creator_id: 1 }]],
    [/UPDATE flocks/, []],
    // Round 18: venue_selected names who confirmed, so the broadcast is now
    // block-filtered like every other identity-bearing flock event.
    [/FROM user_blocks/, []],
  ];

  // App.js matches with `f.id !== data.flockId` against the integer id the REST
  // API gave it, and routes/venues.js sends `parseInt(...)` for the same event
  // names. A socket payload of "42" produced an event every client discarded.
  await fire(socket, 'select_venue', { flockId: '42', venue_name: "Joe's Bar" });

  const selected = io.emitted.find((e) => e.event === 'venue_selected');
  assert.ok(selected);
  assert.strictEqual(selected.payload.flockId, 42);
  assert.strictEqual(selected.room, 'flock:42', 'and the room name is unchanged');
});

// ---------------------------------------------------------------------------
// 5. Vote tallies group by the thing the unique key is on
// ---------------------------------------------------------------------------

test('vote_venue tallies group by venue_name alone, so one venue is one row', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/pg_advisory_xact_lock/, []],
    [/DELETE FROM venue_votes/, []],
    [/INSERT INTO venue_votes/, []],
    [/FROM venue_votes vv/, []],
    [/FROM guest_votes gv/, []],
    [/FROM flock_members WHERE flock_id = \$1 AND status/, []],
  ];

  await fire(socket, 'vote_venue', { flockId: 42, venue_name: "Joe's Bar", venue_id: 'abc' });

  const tally = calls.find((c) => /FROM venue_votes vv/.test(c.sql));
  assert.ok(tally, 'the tally still runs');
  assert.ok(
    /GROUP BY venue_name(?!\s*,)/.test(tally.sql),
    `grouping by (name, id) splits one venue into several rows: ${tally.sql}`
  );

  // And a re-vote that arrives without a place id must not erase the one the
  // row already has — that is how the mixed-id rows appeared to begin with.
  const upsert = calls.find((c) => /INSERT INTO venue_votes/.test(c.sql));
  assert.ok(/COALESCE\(EXCLUDED\.venue_id/.test(upsert.sql), upsert.sql);
});
