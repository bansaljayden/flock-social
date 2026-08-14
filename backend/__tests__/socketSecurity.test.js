// Run: node --test  (from backend/)
//
// Realtime security audit (2026-08-14). Every test here is a regression guard
// for something that was exploitable over a plain Socket.io connection:
//
//   1. Rate limits were per SOCKET only. A socket id is free, nothing capped
//      how many an account could hold, and a reconnect started a fresh bucket —
//      so every write limit could be multiplied at will.
//   2. Authentication happened ONCE, at the handshake, and a connection has no
//      maximum lifetime. Password changes, account claims and deletions all
//      bump/remove the row the token points at, and none of them reached an
//      already-open socket.
//   3. Flock room membership was checked at join_flock and then trusted for the
//      life of the connection, while `flock:{id}` carries the budget ceiling
//      and per-person bill shares.
//   4. flock_invite echoed the client's own `invitedUserIds` array back into
//      the room without validation.
const test = require('node:test');
const assert = require('node:assert');

const pool = require('../config/database');
const {
  registerHandlers,
  allowEvent,
  clearBuckets,
  trackUserSocket,
  evaluateSession,
  revalidateSession,
  staleFlockRooms,
  __resetRateLimiters,
  MAX_SOCKETS_PER_USER,
} = require('../sockets/handlers');

// --- harness ---------------------------------------------------------------

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
    to(room) {
      return {
        except() { return this; },
        emit(event, payload) { emitted.push({ target: room, event, payload }); },
      };
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
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  };
}

// Route mocked SQL by pattern. First match wins, so order the specific
// patterns first. An unmatched query is a loud failure, not an empty result —
// a silent {rows: []} would make a broken test look like a passing one.
function mockPool(routes, calls) {
  const real = pool.query;
  pool.query = async (text, params) => {
    if (calls) calls.push({ text: String(text), params });
    for (const [pattern, rows] of routes) {
      if (pattern.test(text)) {
        return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
    }
    throw new Error(`unexpected query: ${String(text).replace(/\s+/g, ' ').slice(0, 90)}`);
  };
  return () => { pool.query = real; };
}

const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);

// --- 1. rate limiting: per connection AND per account ----------------------

test('a second socket does not buy a second full allowance', () => {
  __resetRateLimiters();
  const phone = { id: 'phone', user: { id: 1 } };
  const laptop = { id: 'laptop', user: { id: 1 } };

  // Per-socket limit 2 => per-user limit 4 (USER_LIMIT_MULTIPLIER).
  assert.strictEqual(allowEvent(phone, 'send_message', 2, 10_000), true);
  assert.strictEqual(allowEvent(phone, 'send_message', 2, 10_000), true);
  assert.strictEqual(allowEvent(phone, 'send_message', 2, 10_000), false, 'per-socket ceiling');

  // The refused attempt still spends the account's budget, so opening more
  // connections cannot be used to buy back what was already used.
  assert.strictEqual(allowEvent(laptop, 'send_message', 2, 10_000), true);
  assert.strictEqual(
    allowEvent(laptop, 'send_message', 2, 10_000),
    false,
    'the account ceiling must bite on the second connection — this was `true` before the fix'
  );
});

test('limits are per event, so one flooded event does not silence the others', () => {
  __resetRateLimiters();
  const s = { id: 's', user: { id: 2 } };
  assert.strictEqual(allowEvent(s, 'typing', 1, 10_000), true);
  assert.strictEqual(allowEvent(s, 'typing', 1, 10_000), false);
  assert.strictEqual(allowEvent(s, 'send_message', 1, 10_000), true);
});

test('users are isolated from each other', () => {
  __resetRateLimiters();
  const mine = { id: 'a', user: { id: 3 } };
  const theirs = { id: 'b', user: { id: 4 } };
  assert.strictEqual(allowEvent(mine, 'send_dm', 1, 10_000), true);
  assert.strictEqual(allowEvent(mine, 'send_dm', 1, 10_000), false);
  assert.strictEqual(allowEvent(theirs, 'send_dm', 1, 10_000), true);
});

test('reconnecting does not reset the account budget while another socket lives', () => {
  __resetRateLimiters();
  const io = fakeIo();
  const first = { id: 'first', user: { id: 5 } };
  const second = { id: 'second', user: { id: 5 } };
  trackUserSocket(io, first);
  trackUserSocket(io, second);

  allowEvent(first, 'vote_venue', 1, 10_000);  // user 1/2
  allowEvent(second, 'vote_venue', 1, 10_000); // user 2/2

  clearBuckets(first);
  const reconnected = { id: 'third', user: { id: 5 } };
  trackUserSocket(io, reconnected);
  assert.strictEqual(
    allowEvent(reconnected, 'vote_venue', 1, 10_000),
    false,
    'a fresh socket id must not hand back a spent account budget'
  );

  // Dropping every connection is not a reset either — that is the same bypass
  // wearing a hat. The window, not the connection, is what expires.
  clearBuckets(second);
  clearBuckets(reconnected);
  const later = { id: 'fourth', user: { id: 5 } };
  assert.strictEqual(allowEvent(later, 'vote_venue', 1, 10_000), false);
});

test('a spent account budget is released by time, not by reconnecting', async () => {
  __resetRateLimiters();
  const s = { id: 'brief', user: { id: 9 } };
  assert.strictEqual(allowEvent(s, 'send_dm', 1, 5), true);
  assert.strictEqual(allowEvent(s, 'send_dm', 1, 5), false);
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.strictEqual(allowEvent(s, 'send_dm', 1, 5), true, 'the window rolls over on its own');
});

test('concurrent sockets per account are capped, oldest evicted', () => {
  __resetRateLimiters();
  const io = fakeIo();
  const made = [];
  for (let i = 0; i < MAX_SOCKETS_PER_USER + 3; i++) {
    const s = { id: `s${i}`, user: { id: 6 }, disconnect(force) { s.killed = force; } };
    io.sockets.sockets.set(s.id, s);
    made.push(s);
    trackUserSocket(io, s);
  }
  const killed = made.filter((s) => s.killed === true).map((s) => s.id);
  assert.deepStrictEqual(killed, ['s0', 's1', 's2'], 'the three oldest go, the newest stay');
});

// --- 2. session revalidation on a live connection --------------------------

test('evaluateSession: a deleted account cannot keep its socket', () => {
  assert.strictEqual(evaluateSession({ tv: 0 }, undefined), 'account_deleted');
  assert.strictEqual(evaluateSession({ tv: 0 }, null), 'account_deleted');
});

test('evaluateSession: a ban applied mid-connection is fatal', () => {
  assert.strictEqual(
    evaluateSession({ tv: 2 }, { id: 1, is_banned: true, token_version: 2 }),
    'account_suspended'
  );
});

test('evaluateSession: a token_version bump kills a socket opened before it', () => {
  // This is the whole point of the bump: a password change or an OAuth account
  // claim is meant to evict whoever is holding a stolen token. It did not, over
  // an established socket.
  assert.strictEqual(
    evaluateSession({ tv: 0 }, { id: 1, is_banned: false, token_version: 1 }),
    'session_revoked'
  );
});

test('evaluateSession: legacy tokens with no tv claim keep working', () => {
  // Same backward-compatibility rule as middleware/auth.js: missing === 0.
  assert.strictEqual(evaluateSession({}, { id: 1, is_banned: false, token_version: 0 }), null);
  assert.strictEqual(evaluateSession({ tv: 3 }, { id: 1, is_banned: false, token_version: 3 }), null);
});

test('a live socket is cut loose when its session stops being valid', async () => {
  const jwt = require('jsonwebtoken');
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-for-socket-revalidation';

  const token = jwt.sign({ userId: 50, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '24h' });
  const withSession = (userRows, memberRows = []) => mockPool([
    [/FROM users WHERE id = \$1/, userRows],
    [/FROM flock_members WHERE user_id = \$1/, memberRows],
  ]);

  const connected = () => {
    const s = fakeSocket('live', { id: 50, name: 'Old Name' });
    s.handshake = { auth: { token } };
    s.rooms.add('user:50');
    return s;
  };

  // Deleted account: the row is gone, the socket must go with it.
  let restore = withSession([]);
  try {
    const s = connected();
    assert.strictEqual(await revalidateSession(s), 'account_deleted');
    assert.strictEqual(s.disconnected, true);
    assert.strictEqual(s.emitted.at(-1).event, 'session_revoked');
  } finally { restore(); }

  // Password change / account claim bumped token_version.
  restore = withSession([{ id: 50, is_banned: false, token_version: 1 }]);
  try {
    const s = connected();
    assert.strictEqual(await revalidateSession(s), 'session_revoked');
    assert.strictEqual(s.disconnected, true);
  } finally { restore(); }

  // Banned after connecting.
  restore = withSession([{ id: 50, is_banned: true, token_version: 0 }]);
  try {
    const s = connected();
    assert.strictEqual(await revalidateSession(s), 'account_suspended');
  } finally { restore(); }

  // Expired token on a connection that outlived it.
  restore = withSession([{ id: 50, is_banned: false, token_version: 0 }]);
  try {
    const s = connected();
    s.handshake = { auth: { token: jwt.sign({ userId: 50, tv: 0 }, process.env.JWT_SECRET, { expiresIn: -10 }) } };
    assert.strictEqual(await revalidateSession(s), 'session_expired');
    assert.strictEqual(s.disconnected, true);
  } finally { restore(); }

  // A healthy session survives, and its identity snapshot is refreshed.
  restore = withSession([{ id: 50, is_banned: false, token_version: 0, name: 'New Name' }]);
  try {
    const s = connected();
    assert.strictEqual(await revalidateSession(s), null);
    assert.ok(!s.disconnected);
    assert.strictEqual(s.user.name, 'New Name');
  } finally { restore(); }

  // A database outage must not disconnect anyone.
  restore = mockPool([[/FROM users WHERE id = \$1/, () => { throw new Error('ECONNREFUSED'); }]]);
  try {
    const s = connected();
    assert.strictEqual(await revalidateSession(s), null);
    assert.ok(!s.disconnected, 'fail open on infrastructure errors, closed on identity ones');
  } finally { restore(); }

  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

test('revalidation evicts a socket from flock rooms it is no longer a member of', async () => {
  const jwt = require('jsonwebtoken');
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-for-socket-revalidation';
  const token = jwt.sign({ userId: 51, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '24h' });

  const restore = mockPool([
    [/FROM users WHERE id = \$1/, [{ id: 51, is_banned: false, token_version: 0, name: 'Ex' }]],
    // Still an accepted member of 1, no longer of 2.
    [/FROM flock_members WHERE user_id = \$1/, [{ flock_id: 1 }]],
  ]);
  try {
    const s = fakeSocket('ex', { id: 51, name: 'Ex' });
    s.handshake = { auth: { token } };
    s.rooms.add('user:51');
    s.rooms.add('flock:1');
    s.rooms.add('flock:2');

    assert.strictEqual(await revalidateSession(s), null);
    assert.ok(s.rooms.has('flock:1'), 'a live membership keeps its room');
    assert.ok(
      !s.rooms.has('flock:2'),
      'flock:{id} carries the budget ceiling and per-person bill shares — an ended membership must not keep listening'
    );
    assert.ok(!s.disconnected, 'losing one membership is not a session revocation');
  } finally {
    restore();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

// --- 3. flock rooms are re-verified, not trusted for the connection's life --

test('staleFlockRooms drops rooms membership no longer justifies', () => {
  const rooms = new Set(['someSocketId', 'user:7', 'flock:1', 'flock:2', 'venue:abc']);
  assert.deepStrictEqual(staleFlockRooms(rooms, [1]), ['flock:2']);
  assert.deepStrictEqual(staleFlockRooms(rooms, [1, 2]), []);
});

test('staleFlockRooms fails closed on room ids it cannot account for', () => {
  const rooms = new Set(['flock:abc', 'flock:', 'flock:9x']);
  assert.deepStrictEqual(staleFlockRooms(rooms, [9]), ['flock:abc', 'flock:', 'flock:9x']);
});

test('staleFlockRooms compares ids by value, not by type', () => {
  assert.deepStrictEqual(staleFlockRooms(new Set(['flock:42']), ['42']), []);
  assert.deepStrictEqual(staleFlockRooms(new Set(['flock:42']), [42]), []);
});

// --- 4. join_flock membership + presence scoping ---------------------------

test('join_flock refuses a flock the socket is not a member of', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, []],
  ]);
  try {
    const io = fakeIo();
    const outsider = fakeSocket('out', { id: 77, name: 'Mallory' });
    registerHandlers(io, outsider);
    await fire(outsider, 'join_flock', 4101);

    assert.ok(!outsider.rooms.has('flock:4101'), 'must not be in the room');
    const err = outsider.emitted.find((e) => e.event === 'error');
    assert.match(err.payload.message, /Not a member/);
    assert.ok(!outsider.emitted.some((e) => e.event === 'room_members'));
  } finally {
    restore();
  }
});

test('join_flock admits a member and scopes presence around blocks', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    // getInvisibleUserIds — user 91 is blocked in one direction or the other.
    [/FROM user_blocks WHERE blocker_id = \$1/, [{ id: 91 }]],
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
  ]);
  try {
    const io = fakeIo();

    const blocked = fakeSocket('blocked', { id: 91, name: 'Blocked' });
    const other = fakeSocket('other', { id: 92, name: 'Ada' });
    const me = fakeSocket('me', { id: 90, name: 'Me' });
    registerHandlers(io, blocked);
    registerHandlers(io, other);
    registerHandlers(io, me);

    await fire(blocked, 'join_flock', 4102);
    await fire(other, 'join_flock', 4102);
    await fire(me, 'join_flock', 4102);

    assert.ok(me.rooms.has('flock:4102'));
    const roster = me.emitted.find((e) => e.event === 'room_members').payload;
    const ids = roster.members.map((m) => m.userId);
    assert.ok(ids.includes(92), 'ordinary members are listed');
    assert.ok(!ids.includes(91), 'a blocked user must not appear in presence');
    // The id goes back out exactly as the client sent it — App.js compares
    // it with === against a number from the REST API.
    assert.strictEqual(roster.flockId, 4102);
  } finally {
    restore();
  }
});

test('join_flock presence does not double-count a client that sends 5 and "5"', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    [/FROM user_blocks WHERE blocker_id = \$1/, []],
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
  ]);
  try {
    const io = fakeIo();
    const a = fakeSocket('a', { id: 80, name: 'A' });
    const b = fakeSocket('b', { id: 81, name: 'B' });
    registerHandlers(io, a);
    registerHandlers(io, b);

    await fire(a, 'join_flock', 4103);
    await fire(a, 'join_flock', '4103'); // same Socket.io room, either way
    await fire(b, 'join_flock', 4103);

    assert.deepStrictEqual(
      [...a.rooms].filter((r) => r.startsWith('flock:')),
      ['flock:4103'],
      'both spellings resolve to one room'
    );
    const roster = b.emitted.find((e) => e.event === 'room_members').payload;
    assert.strictEqual(roster.members.length, 2, 'one entry per user, not per id spelling');

    // Disconnecting announces each departure once, not once per spelling.
    a.handlers.get('disconnect')();
    const offline = io.emitted.filter((e) => e.event === 'member_offline');
    assert.strictEqual(offline.length, 1);
    assert.strictEqual(offline[0].room, 'flock:4103');
  } finally {
    restore();
  }
});

// --- 5. flock_invite echoes verified state, not client input ---------------

test('flock_invite relays only the invites the database confirmed', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    [/status = 'invited'/, [{ user_id: 42 }]],
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM flocks WHERE id = \$1/, [{ id: 4104, name: 'Trip' }]],
    [/FROM user_blocks/, []],
  ]);
  try {
    const io = fakeIo();
    const member = fakeSocket('m', { id: 70, name: 'Host' });
    registerHandlers(io, member);

    await fire(member, 'flock_invite', {
      flockId: 4104,
      invitedUserIds: [42, 'not-an-id', { evil: true }, 999999],
    });

    // Only the confirmed invitee is notified.
    const received = io.emitted.filter((e) => e.event === 'flock_invite_received');
    assert.deepStrictEqual(received.map((e) => e.room), ['user:42']);

    // ...and the room echo carries that same verified list, not the array the
    // client made up.
    const echo = member.emitted.find((e) => e.event === 'flock_members_invited');
    assert.deepStrictEqual(echo.payload.invitedUserIds, [42]);
    assert.strictEqual(echo.target, 'flock:4104');
  } finally {
    restore();
  }
});

// --- 6. venue rooms: gated subscription, anonymous payloads ----------------

test('join_venue refuses ids that are not shaped like a place id, without touching the database', async () => {
  __resetRateLimiters();
  const calls = [];
  const restore = mockPool([[/EXISTS/, [{ known: true }]]], calls);
  try {
    const s = fakeSocket('shape', { id: 30, name: 'Snoop' });
    registerHandlers(fakeIo(), s);
    for (const bad of [null, undefined, 42, '', 'x', 'x'.repeat(300), "'; DROP TABLE users--", { placeId: ['a'] }]) {
      await fire(s, 'join_venue', bad);
    }
    assert.deepStrictEqual([...s.rooms].filter((r) => r.startsWith('venue:')), []);
    assert.strictEqual(calls.length, 0, 'a malformed id is rejected before any query');
  } finally {
    restore();
  }
});

test('join_venue will not subscribe a socket to a venue this system does not know', async () => {
  __resetRateLimiters();
  const restore = mockPool([[/EXISTS/, [{ known: false }]]]);
  try {
    const s = fakeSocket('unknown', { id: 31, name: 'Snoop' });
    registerHandlers(fakeIo(), s);
    await fire(s, 'join_venue', { placeId: 'ChIJmadeUpPlaceIdThatIsNotOurs' });
    assert.deepStrictEqual([...s.rooms].filter((r) => r.startsWith('venue:')), []);
  } finally {
    restore();
  }
});

test('join_venue admits a known venue and bounds how many one socket can follow', async () => {
  __resetRateLimiters();
  const restore = mockPool([[/EXISTS/, [{ known: true }]]]);
  try {
    const s = fakeSocket('watcher', { id: 32, name: 'Regular' });
    registerHandlers(fakeIo(), s);
    for (let i = 0; i < 14; i++) {
      await fire(s, 'join_venue', { placeId: `ChIJknownVenue${String(i).padStart(3, '0')}` });
    }
    const rooms = [...s.rooms].filter((r) => r.startsWith('venue:'));
    assert.strictEqual(rooms.length, 10, 'capped');
    assert.ok(rooms.includes('venue:ChIJknownVenue013'), 'the newest subscription is kept');
    assert.ok(!rooms.includes('venue:ChIJknownVenue000'), 'the oldest is evicted, not the newest refused');
  } finally {
    restore();
  }
});

test('crowd_update publishes no user identifier into the public venue room', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    [/FROM venue_profiles WHERE user_id = \$1/, [{ '?column?': 1 }]],
  ]);
  try {
    const io = fakeIo();
    const owner = fakeSocket('owner', { id: 33, name: 'Owner', role: 'venue_owner' });
    registerHandlers(io, owner);
    await fire(owner, 'crowd_update', { venue_id: 'ChIJownedVenue0001', level: 'busy' });

    const update = io.emitted.find((e) => e.event === 'crowd_update');
    assert.strictEqual(update.room, 'venue:ChIJownedVenue0001');
    assert.deepStrictEqual(Object.keys(update.payload).sort(), ['level', 'timestamp', 'venue_id']);
    // The room is not block filtered: "user 33 is at this venue right now"
    // must not be derivable from anything in here. (The timestamp is exempt —
    // it is a clock reading, and it may contain any digits at all.)
    const { timestamp, ...identifying } = update.payload;
    assert.strictEqual(typeof timestamp, 'number');
    assert.ok(!JSON.stringify(identifying).includes('33'));
    assert.strictEqual(update.payload.updated_by, undefined);
  } finally {
    restore();
  }
});

// --- 7. malformed payloads must not take the process down ------------------

test('handlers survive null, wrong-typed and missing payloads', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => { throw new Error('invalid input syntax for type integer'); }],
    [/FROM user_blocks/, []],
    [/./, []],
  ]);
  try {
    const io = fakeIo();
    const s = fakeSocket('junk', { id: 60, name: 'Junk' });
    registerHandlers(io, s);

    const junk = [null, undefined, 0, '', [], { flockId: { nested: true } }, 'x'.repeat(1000)];
    for (const payload of junk) {
      await fire(s, 'join_flock', payload);
      await fire(s, 'leave_flock', payload);
      await fire(s, 'send_message', payload);
      await fire(s, 'vote_venue', payload);
      await fire(s, 'typing', payload);
      await fire(s, 'update_location', payload);
      await fire(s, 'stop_sharing_location', payload);
      await fire(s, 'join_venue', payload);
      await fire(s, 'leave_venue', payload);
      await fire(s, 'dm_typing', payload);
      await fire(s, 'send_dm', payload);
      await fire(s, 'flock_invite', payload);
      await fire(s, 'select_venue', payload);
      await fire(s, 'crowd_update', payload);
    }
    // Reaching here at all is the assertion: every one of those is a rejected
    // promise inside a handler, and an unhandled rejection exits the process
    // on Node 18+.
    assert.ok(true);
  } finally {
    restore();
  }
});
