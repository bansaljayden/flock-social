// Run: node --test  (from backend/)
//
// Adversarial re-audit of sockets/handlers.js (round 17). Guards the last
// identity-bearing flock-room broadcasts that did NOT obey blocks:
//
//   - stop_sharing_location -> member_stopped_sharing. update_location (the pin
//     itself) and the disconnect handler's own member_stopped_sharing both
//     exclude blocked users; this path did not, so a blocked peer never got the
//     pin but was still told, by user id, the instant it stopped.
//
//     LATER, THE OTHER HALF OF THAT RULE. A peer blocked BEFORE the share began
//     never held the pin and still hears nothing. A peer blocked (either way)
//     DURING the share did hold it, and the app drops a pin only on this stop,
//     so the block filter left them the other person's last coordinates for the
//     rest of the session. The server now records who each pin went to
//     (sockets/handlers.js, flockPinHolders) and every end of a share reaches
//     them: the stop, the next tick after the block, and the disconnect, which
//     also no longer drops the stop when the block lookup fails.
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

test('stop_sharing_location reaches everyone the pin reached, minus blocks', async () => {
  // THE STOP MUST USE THE PIN'S AUDIENCE. update_location fans out to
  // `user:{id}` for every accepted member; this used to broadcast to
  // `flock:{id}`, which holds only the sockets currently ON that chat screen.
  // A member sitting on the Map tab who never opened the chat therefore
  // received every location_update - the client stores them keyed by user id
  // with no flock scoping and renders them as markers - and was not in the
  // room to hear the stop. The pin stayed on their map for the rest of the
  // session. A pin that says a person is somewhere they left is the one
  // failure this feature must not have.
  __resetRateLimiters();
  const emitted = [];
  const restore = mockPool([
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/,
      [{ user_id: 7 }, { user_id: 8 }, { user_id: 9 }]],
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM user_blocks/, [{ id: 9 }]], // user 9 is invisible to the actor
  ]);
  try {
    const socket = fakeSocket('s1', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'stop_sharing_location', { flockId: 42 });

    const stops = emitted.filter((e) => e.event === 'member_stopped_sharing');
    assert.deepStrictEqual(stops.map((e) => e.room).sort(), ['user:7', 'user:8'],
      'the stop went to the room, not to the members who hold the pin');
    assert.ok(!stops.some((e) => e.room === 'user:9'), 'the blocked peer is excluded');
    for (const stop of stops) {
      assert.strictEqual(stop.payload.userId, 5);
      assert.strictEqual(stop.payload.flockId, 42);
    }
  } finally {
    restore();
  }
});

test('stop_sharing_location stays silent when the block lookup fails (fail closed)', async () => {
  __resetRateLimiters();
  const emitted = [];
  const restore = mockPool([
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/,
      [{ user_id: 7 }]],
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

// --- the pin's holders: a block mid-share, a lookup that fails -------------
//
// One world for the tests below: Ava (5) shares in flock 42, whose other
// accepted members are 7, 8 and 9. `blocked` is who is invisible to Ava right
// now, and it can change between two events the way a block lands mid-share.
// `blocksDown` makes the block list unreadable, and `member` says whether Ava
// still holds an accepted row.
function pinWorld() {
  const state = { blocked: [], blocksDown: false, member: true };
  const restore = mockPool([
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/,
      () => [{ user_id: 7 }, { user_id: 8 }, { user_id: 9 }]],
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => (state.member ? [{ id: 1 }] : [])],
    [/FROM user_blocks/, () => {
      if (state.blocksDown) throw new Error('db blip');
      return state.blocked.map((id) => ({ id }));
    }],
  ]);
  return { state, restore };
}
const eventsTo = (emitted, event) => emitted.filter((e) => e.event === event).map((e) => e.room).sort();

test('a member blocked MID-SHARE still hears the stop, because they are holding the pin', async () => {
  // THE DEFECT. The block filter on the stop is right for somebody who never
  // saw the pin and wrong for somebody who did: the app drops a pin only on
  // member_stopped_sharing, so skipping 9 here left Ava's last coordinates on
  // 9's map after 9 (or Ava) had blocked the other. The stop carries no
  // position, and 9 was shown the position it withdraws.
  __resetRateLimiters();
  const emitted = [];
  const { state, restore } = pinWorld();
  try {
    const socket = fakeSocket('pin1', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'update_location', { flockId: 42, lat: 40.7, lng: -74 });
    assert.deepStrictEqual(eventsTo(emitted, 'location_update'), ['user:7', 'user:8', 'user:9'],
      'fixture precondition: all three were shown the pin');

    state.blocked = [9]; // the block lands while the share is live
    emitted.length = 0;
    await fire(socket, 'stop_sharing_location', { flockId: 42 });

    const stops = emitted.filter((e) => e.event === 'member_stopped_sharing');
    assert.deepStrictEqual(stops.map((e) => e.room).sort(), ['user:7', 'user:8', 'user:9'],
      'the member blocked mid-share was left holding the last position');
    for (const stop of stops) {
      assert.deepStrictEqual(stop.payload, { userId: 5, flockId: 42 }, 'an id and a flock, never a position');
    }
  } finally {
    restore();
  }
});

test('a block mid-share takes the pin off the other map on the sharer\'s NEXT tick', async () => {
  // Not whenever the sharer gets round to stopping, which can be an hour
  // later. The tick that stops sending 9 the position tells 9 it ended.
  __resetRateLimiters();
  const emitted = [];
  const { state, restore } = pinWorld();
  try {
    const socket = fakeSocket('pin2', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'update_location', { flockId: 42, lat: 40.7, lng: -74 });

    state.blocked = [9];
    emitted.length = 0;
    await fire(socket, 'update_location', { flockId: 42, lat: 40.71, lng: -74 });
    assert.deepStrictEqual(eventsTo(emitted, 'location_update'), ['user:7', 'user:8'],
      'the new position must not reach the blocked member');
    assert.deepStrictEqual(eventsTo(emitted, 'member_stopped_sharing'), ['user:9'],
      'and the blocked member is told the share ended for them, now');

    emitted.length = 0;
    await fire(socket, 'stop_sharing_location', { flockId: 42 });
    assert.deepStrictEqual(eventsTo(emitted, 'member_stopped_sharing'), ['user:7', 'user:8'],
      '9 was already told and no longer holds the pin, so the real stop does not go to them again');
  } finally {
    restore();
  }
});

test('a member blocked BEFORE the share began is never told it ended (round 17 still holds)', async () => {
  __resetRateLimiters();
  const emitted = [];
  const { state, restore } = pinWorld();
  state.blocked = [9];
  try {
    const socket = fakeSocket('pin3', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'update_location', { flockId: 42, lat: 40.7, lng: -74 });
    await fire(socket, 'stop_sharing_location', { flockId: 42 });
    await fire(socket, 'disconnect');
    assert.ok(!emitted.some((e) => e.room === 'user:9'),
      'a peer who never held the pin learned when the sharer stopped, which is presence');
    assert.deepStrictEqual(eventsTo(emitted, 'member_stopped_sharing'), ['user:7', 'user:8']);
  } finally {
    restore();
  }
});

test('an explicit stop with an unreadable block list still reaches the pin\'s holders, and only them', async () => {
  // The roster half of the stop cannot be filtered without the block list,
  // so it is skipped; the recorded holders need no query at all.
  __resetRateLimiters();
  const emitted = [];
  const { state, restore } = pinWorld();
  state.blocked = [9]; // 9 never held the pin
  try {
    const socket = fakeSocket('pin4', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'update_location', { flockId: 42, lat: 40.7, lng: -74 });

    state.blocksDown = true;
    emitted.length = 0;
    await fire(socket, 'stop_sharing_location', { flockId: 42 });
    assert.deepStrictEqual(eventsTo(emitted, 'member_stopped_sharing'), ['user:7', 'user:8']);
  } finally {
    restore();
  }
});

test('the disconnect announces the stop even when the block lookup fails, and drops only member_offline', async () => {
  // THE DEFECT. The disconnect returned the moment getInvisibleUserIds threw,
  // before the location-stop loop, so a database blip at the likeliest moment
  // a share ends (the app going to the background) left the pin on every map.
  __resetRateLimiters();
  const emitted = [];
  const { state, restore } = pinWorld();
  try {
    const socket = fakeSocket('pin5', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'join_flock', 42);
    await fire(socket, 'update_location', { flockId: 42, lat: 40.7, lng: -74 });

    state.blocksDown = true;
    emitted.length = 0;
    await fire(socket, 'disconnect');

    assert.ok(!emitted.some((e) => e.event === 'member_offline'),
      'member_offline carries the name, so it still waits on the block list');
    assert.deepStrictEqual(eventsTo(emitted, 'member_stopped_sharing'), ['user:7', 'user:8', 'user:9'],
      'the stop went nowhere because the block list could not be read');
  } finally {
    restore();
  }
});

test('the disconnect reaches a member blocked mid-share, like the explicit stop does', async () => {
  __resetRateLimiters();
  const emitted = [];
  const { state, restore } = pinWorld();
  try {
    const socket = fakeSocket('pin6', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'join_flock', 42);
    await fire(socket, 'update_location', { flockId: 42, lat: 40.7, lng: -74 });

    state.blocked = [9];
    emitted.length = 0;
    await fire(socket, 'disconnect');

    const offline = emitted.find((e) => e.event === 'member_offline');
    assert.ok(offline, 'presence still goes out when the lookup works');
    assert.deepStrictEqual(offline.exceptRooms, ['user:9'], 'and it still skips the blocked member');
    assert.deepStrictEqual(eventsTo(emitted, 'member_stopped_sharing'), ['user:7', 'user:8', 'user:9']);
  } finally {
    restore();
  }
});

test('a share from a socket that never held the flock room still ends on disconnect', async () => {
  // update_location never needed the room, and the disconnect used to end
  // shares only for the rooms it was leaving.
  __resetRateLimiters();
  const emitted = [];
  const { restore } = pinWorld();
  try {
    const socket = fakeSocket('pin7', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'update_location', { flockId: 42, lat: 40.7, lng: -74 });
    emitted.length = 0;
    await fire(socket, 'disconnect');
    assert.deepStrictEqual(eventsTo(emitted, 'member_stopped_sharing'), ['user:7', 'user:8', 'user:9']);
  } finally {
    restore();
  }
});

test('a position refused because the membership ended tells whoever still holds the pin, once', async () => {
  // A plan can go without the leave or delete routes announcing anything: an
  // account deletion cascades away every plan its owner created. The app keeps
  // sending positions for a plan it no longer has, and each is refused at the
  // membership check; the first refusal is the moment the share is over.
  __resetRateLimiters();
  const emitted = [];
  const { state, restore } = pinWorld();
  try {
    const socket = fakeSocket('pin10', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'update_location', { flockId: 42, lat: 40.7, lng: -74 });

    state.member = false;
    emitted.length = 0;
    await fire(socket, 'update_location', { flockId: 42, lat: 40.71, lng: -74 });
    assert.deepStrictEqual(eventsTo(emitted, 'location_update'), [], 'a non-member position reached a map');
    assert.deepStrictEqual(eventsTo(emitted, 'member_stopped_sharing'), ['user:7', 'user:8', 'user:9']);

    emitted.length = 0;
    await fire(socket, 'update_location', { flockId: 42, lat: 40.72, lng: -74 });
    assert.deepStrictEqual(emitted, [], 'the holders were told once; later refusals say nothing');
  } finally {
    restore();
  }
});

test('a stop after the membership ended reaches the people who hold the pin, and no one else', async () => {
  // Round 13's gate still stands for the roster: a non-member cannot fire
  // stops at a flock's members. The recorded holders are the caller's own
  // audience, so telling them can only ever clear the caller's own position.
  __resetRateLimiters();
  const emitted = [];
  const { state, restore } = pinWorld();
  state.blocked = [9];
  try {
    const socket = fakeSocket('pin8', { id: 5, name: 'Ava' }, emitted);
    registerHandlers(fakeIo(emitted), socket);
    await fire(socket, 'update_location', { flockId: 42, lat: 40.7, lng: -74 });

    state.member = false;
    emitted.length = 0;
    await fire(socket, 'stop_sharing_location', { flockId: 42 });
    assert.deepStrictEqual(eventsTo(emitted, 'member_stopped_sharing'), ['user:7', 'user:8']);

    // And a stranger with no pin anywhere still reaches nobody.
    const stranger = fakeSocket('pin9', { id: 66, name: 'Mallory' }, emitted);
    registerHandlers(fakeIo(emitted), stranger);
    emitted.length = 0;
    await fire(stranger, 'stop_sharing_location', { flockId: 42 });
    assert.deepStrictEqual(emitted.filter((e) => e.event === 'member_stopped_sharing'), []);
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
