// Run: node --test  (from backend/)
//
// Adversarial re-audit of sockets/handlers.js (round 17). Guards the last
// identity-bearing flock-room broadcasts that did NOT obey blocks:
//
//   - stop_sharing_location -> member_stopped_sharing. update_location (the pin
//     itself) and the disconnect handler's own member_stopped_sharing both
//     exclude blocked users; this path did not, so a blocked peer never got the
//     pin but was still told, by user id, the instant it stopped.
//   - flock_invite_response -> flock_invite_responded. Its REST twin
//     (routes/flocks.js) fans out block-filtered; the socket path broadcast
//     "<name> accepted" by name to a blocker sitting in the room.
//
// Also re-confirms the session revalidator still tears down / passes correctly
// now that its jwt.verify pins the handshake's algorithm set.
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const pool = require('../config/database');
const { registerHandlers, revalidateSession, __resetRateLimiters } = require('../sockets/handlers');

// --- harness ---------------------------------------------------------------
//
// An emitter that records BOTH what was emitted and which rooms it was told to
// exclude, so a test can prove the block filter was actually applied and did
// not merely happen to have nothing to exclude.
function recordingEmitter(store, room) {
  return {
    exceptRooms: null,
    except(rooms) { this.exceptRooms = rooms; return this; },
    emit(event, payload) { store.push({ room, event, payload, exceptRooms: this.exceptRooms }); },
  };
}

function fakeSocket(id, user, emitted) {
  const handlers = new Map();
  const rooms = new Set();
  return {
    id, user, rooms,
    handshake: null, // keep the revalidation timer off
    on(event, handler) { handlers.set(event, handler); },
    join(room) { rooms.add(room); },
    leave(room) { rooms.delete(room); },
    emit(event, payload) { emitted.push({ room: 'self', event, payload, exceptRooms: null }); },
    to(room) { return recordingEmitter(emitted, room); },
    disconnect() { this.disconnected = true; },
    handlers,
  };
}

function fakeIo(emitted) {
  return {
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
    to(room) { return recordingEmitter(emitted, room); },
  };
}

function mockPool(routes) {
  const real = pool.query;
  pool.query = async (text) => {
    for (const [pattern, rows] of routes) {
      if (pattern.test(text)) {
        if (typeof rows === 'function') return { rows: rows() };
        return { rows };
      }
    }
    throw new Error(`unexpected query: ${String(text).replace(/\s+/g, ' ').slice(0, 90)}`);
  };
  return () => { pool.query = real; };
}

const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);

// --- stop_sharing_location: block-filtered like its siblings ---------------

test('stop_sharing_location excludes a blocked peer and still notifies the room', async () => {
  __resetRateLimiters();
  const emitted = [];
  const restore = mockPool([
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM user_blocks/, [{ id: 9 }]], // user 9 is invisible to the actor
  ]);
  try {
    const socket = fakeSocket('s1', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'stop_sharing_location', { flockId: 42 });

    const stop = emitted.find((e) => e.event === 'member_stopped_sharing');
    assert.ok(stop, 'the room is still told sharing stopped');
    assert.strictEqual(stop.room, 'flock:42');
    assert.deepStrictEqual(stop.exceptRooms, ['user:9'], 'the blocked peer is excluded');
    assert.strictEqual(stop.payload.userId, 5);
  } finally {
    restore();
  }
});

test('stop_sharing_location stays silent when the block lookup fails (fail closed)', async () => {
  __resetRateLimiters();
  const emitted = [];
  const restore = mockPool([
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM user_blocks/, () => { throw new Error('db blip'); }],
  ]);
  try {
    const socket = fakeSocket('s2', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'stop_sharing_location', { flockId: 42 });
    assert.ok(
      !emitted.some((e) => e.event === 'member_stopped_sharing'),
      'a leaked presence event is worse than a missed one',
    );
  } finally {
    restore();
  }
});

// --- flock_invite_response: block-filtered, matching its REST twin ----------

test('flock_invite_responded excludes a blocker from the live RSVP toast', async () => {
  __resetRateLimiters();
  const emitted = [];
  const restore = mockPool([
    [/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ status: 'accepted' }]],
    [/FROM flocks WHERE id = \$1/, [{ id: 42, name: 'Trip' }]],
    [/FROM user_blocks/, [{ id: 9 }]],
  ]);
  try {
    const io = fakeIo(emitted);
    const socket = fakeSocket('s3', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(io, socket);
    await fire(socket, 'flock_invite_response', { flockId: 42, action: 'accepted' });

    const rsvp = emitted.find((e) => e.event === 'flock_invite_responded');
    assert.ok(rsvp, 'accepted RSVP is relayed');
    assert.strictEqual(rsvp.room, 'flock:42');
    assert.deepStrictEqual(rsvp.exceptRooms, ['user:9'], 'the blocker never sees it');
    assert.strictEqual(rsvp.payload.userName, 'Ava');
    assert.strictEqual(rsvp.payload.action, 'accepted');
  } finally {
    restore();
  }
});

test('flock_invite_response fails closed when the block lookup throws', async () => {
  __resetRateLimiters();
  const emitted = [];
  const restore = mockPool([
    [/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ status: 'accepted' }]],
    [/FROM flocks WHERE id = \$1/, [{ id: 42, name: 'Trip' }]],
    [/FROM user_blocks/, () => { throw new Error('db blip'); }],
  ]);
  try {
    const io = fakeIo(emitted);
    const socket = fakeSocket('s4', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(io, socket);
    await fire(socket, 'flock_invite_response', { flockId: 42, action: 'accepted' });
    assert.ok(!emitted.some((e) => e.event === 'flock_invite_responded'));
  } finally {
    restore();
  }
});

test('flock_invite_response drops an RSVP whose claimed action does not match the row', async () => {
  __resetRateLimiters();
  const emitted = [];
  const restore = mockPool([
    [/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ status: 'invited' }]],
  ]);
  try {
    const io = fakeIo(emitted);
    const socket = fakeSocket('s5', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(io, socket);
    await fire(socket, 'flock_invite_response', { flockId: 42, action: 'accepted' });
    assert.ok(!emitted.some((e) => e.event === 'flock_invite_responded'), 'only persisted state is relayed');
  } finally {
    restore();
  }
});

// --- session revalidator still correct with the pinned algorithm set --------

test('revalidateSession pins HS256 yet still passes a legitimate token and expires a dead one', async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'reaudit-secret';
  const restore = mockPool([
    [/FROM users WHERE id = \$1/, [{ id: 77, name: 'Ava', is_banned: false, token_version: 0 }]],
  ]);
  try {
    const emitted = [];
    const good = fakeSocket('g', { id: 77, name: 'Ava' }, emitted);
    good.handshake = { auth: { token: jwt.sign({ userId: 77, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '24h' }) } };
    good.rooms = new Set();
    assert.strictEqual(await revalidateSession(good), null, 'a valid HS256 token is not falsely revoked');

    const expired = fakeSocket('e', { id: 77, name: 'Ava' }, emitted);
    expired.handshake = { auth: { token: jwt.sign({ userId: 77, tv: 0 }, process.env.JWT_SECRET, { expiresIn: -10 }) } };
    expired.rooms = new Set();
    assert.strictEqual(await revalidateSession(expired), 'session_expired');
    assert.strictEqual(expired.disconnected, true, 'an expired connection is actually torn down');
  } finally {
    restore();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
