// Run: node --test  (from backend/)
//
// EVENT-LEVEL OBJECT AUTHORIZATION on sockets/handlers.js (round 23 sweep).
// The handshake, session revalidation, and image restamping were hardened in
// earlier rounds; this file is about what each EVENT may touch once a socket
// is legitimately connected. Findings fixed this round, each pinned below:
//
//   1. send_message ran the BILLED Cloud Vision screen before the membership
//      query, so a non-member (including a member kicked mid-session whose
//      socket was still open) could spend paid moderation calls into a flock
//      they could never deliver into. REST and send_dm both already ordered
//      membership first; the socket flock path was the one inversion.
//   2. Presence (roomUsers) is a cache of room state, and routes/flocks.js
//      revokes room access directly (io.socketsLeave) when a membership ends —
//      which the cache could not observe. A departed member stayed on every
//      later joiner's "online" roster for the life of their connection, and
//      their eventual disconnect announced them by name into a flock they had
//      left. join_flock now cross-checks the adapter's live room set, and
//      revalidateSession reconciles the cache on its 60s timer.
//   3. Flock-scoped ids (join_flock, leave_flock, send_message, typing,
//      update_location, stop_sharing_location, flock_invite) were used raw.
//      Postgres trims whitespace casting to int, so '7 ' + kilobytes of
//      padding passed membership for flock 7 and was echoed verbatim to every
//      member at the typing rate, while App.js === comparisons against the
//      integer id silently discarded the event. All normalized via asId now,
//      like vote_venue/select_venue/flock_invite_response since round 16.
//
// Verified-correct-and-pinned (no change needed): vote_venue and select_venue
// authorization, send_dm's block + relationship gates, dm_react's is_hidden
// parity, dm_vote/dm_pin relationship gates, the ephemeral DM block checks,
// friend event relays, and crowd_update's verified-claim gate.
//
// GHOST MODE, for the record: flocks.ghost_mode_enabled is BUDGET anonymity
// (routes/budget.js and routes/billing.js gate the anonymous ghost-commit on
// it). It has nothing to do with location sharing, so update_location has no
// ghost-mode obligation; its privacy controls are membership + mutual blocks,
// both asserted below.
const test = require('node:test');
const assert = require('node:assert');

const pool = require('../config/database');

// Stub the BILLED image screen and the push helper BEFORE handlers.js
// destructures them at require time. moderateText stays real (free, pure).
const moderationMod = require('../utils/moderation');
let visionCalls = 0;
let callLog = null; // when a test installs a call log, VISION markers land in it
moderationMod.moderateImage = async () => {
  visionCalls += 1;
  if (callLog) callLog.push({ text: 'VISION', params: null });
  return { allowed: true };
};
const pushHelper = require('../services/pushHelper');
pushHelper.pushIfOfflineDebounced = async () => {};

const {
  registerHandlers,
  revalidateSession,
  __resetRateLimiters,
} = require('../sockets/handlers');
const { NOT_CONNECTED_MESSAGE } = require('../utils/relationships');

// --- harness (socketSecurity.test.js conventions, plus adapter rooms) -------

function fakeIo() {
  const emitted = [];
  const rooms = new Map(); // room -> Set<socketId>, the adapter's live truth
  return {
    emitted,
    sockets: { sockets: new Map(), adapter: { rooms } },
    to(room) {
      const excluded = [];
      return {
        except(ids) { excluded.push(...ids); return this; },
        emit(event, payload) { emitted.push({ room, event, payload, excluded: [...excluded] }); },
      };
    },
  };
}

// Pass `io` to keep the adapter's room sets in step with join/leave, the way a
// real server does. Omit it and the roster's live-room cross-check sees no room
// set at all, which must mean "cannot verify", never "everyone is stale".
function fakeSocket(id, user, io) {
  const handlers = new Map();
  const emitted = [];
  const rooms = new Set();
  const adapterRooms = io ? io.sockets.adapter.rooms : null;
  const socket = {
    id,
    user,
    rooms,
    handshake: null, // no handshake => no session watchdog timer
    on(event, handler) { handlers.set(event, handler); },
    join(room) {
      rooms.add(room);
      if (adapterRooms) {
        if (!adapterRooms.has(room)) adapterRooms.set(room, new Set());
        adapterRooms.get(room).add(id);
      }
    },
    leave(room) {
      rooms.delete(room);
      if (adapterRooms) adapterRooms.get(room)?.delete(id);
    },
    emit(event, payload) { emitted.push({ target: 'self', event, payload }); },
    to(room) {
      const excluded = [];
      return {
        except(ids) { excluded.push(...ids); return this; },
        emit(event, payload) { emitted.push({ target: room, event, payload, excluded: [...excluded] }); },
      };
    },
    disconnect() { socket.disconnected = true; },
    handlers,
    emitted,
  };
  return socket;
}

function mockPool(routes, calls) {
  const real = pool.query;
  callLog = calls || null;
  pool.query = async (text, params) => {
    if (calls) calls.push({ text: String(text), params });
    for (const [pattern, rows] of routes) {
      if (pattern.test(text)) {
        return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
    }
    throw new Error(`unexpected query: ${String(text).replace(/\s+/g, ' ').slice(0, 90)}`);
  };
  return () => { pool.query = real; callLog = null; };
}

const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);
const errorsOf = (socket) => socket.emitted.filter((e) => e.event === 'error').map((e) => e.payload.message);

const MEMBERSHIP = /SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/;
const BLOCK_PAIR = /blocker_id = \$1 AND blocked_id = \$2/;
const INVISIBLE = /SELECT blocked_id AS id FROM user_blocks/;
const RELATIONSHIP = /SELECT 1 WHERE EXISTS/;
const PNG = 'data:image/png;base64,AAAA';

// --- 1. send_message: membership gates the BILLED image screen --------------

test('a non-member cannot spend a billed Vision call through send_message', async () => {
  __resetRateLimiters();
  visionCalls = 0;
  const calls = [];
  const restore = mockPool([[MEMBERSHIP, []]], calls);
  try {
    const s = fakeSocket('out', { id: 100, name: 'Mallory' });
    registerHandlers(fakeIo(), s);
    await fire(s, 'send_message', { flockId: 4100, message_text: 'hi', message_type: 'image', image_url: PNG });

    assert.deepStrictEqual(errorsOf(s), ['Not a member of this flock']);
    assert.strictEqual(visionCalls, 0,
      'the paid moderation call ran before the membership query — a stranger was spending money');
    assert.ok(!calls.some((c) => /INSERT INTO messages/.test(c.text)), 'nothing may be persisted');
  } finally { restore(); }
});

test('the FREE image refusals still come before membership, matching the REST validator chain', async () => {
  __resetRateLimiters();
  visionCalls = 0;
  const calls = [];
  const restore = mockPool([[MEMBERSHIP, []]], calls);
  try {
    const s = fakeSocket('out2', { id: 101, name: 'Mallory' });
    registerHandlers(fakeIo(), s);
    await fire(s, 'send_message', { flockId: 4100, message_type: 'image', image_url: 'data:image/bmp;base64,AAAA' });

    assert.deepStrictEqual(errorsOf(s), ['Unsupported image format']);
    assert.strictEqual(calls.length, 0, 'a format refusal costs nothing, so it must not cost a query either');
    assert.strictEqual(visionCalls, 0);
  } finally { restore(); }
});

test('a member image send is billed exactly once, strictly after membership is confirmed', async () => {
  __resetRateLimiters();
  visionCalls = 0;
  const calls = [];
  const restore = mockPool([
    [/user_id != \$2/, [{ user_id: 202 }]],
    [MEMBERSHIP, [{ id: 1 }]],
    [/SELECT name FROM flocks WHERE id = \$1/, [{ name: 'Trip' }]],
    [INVISIBLE, []],
    [/INSERT INTO messages/, (params) => [{ id: 9, flock_id: params[0], sender_id: params[1], message_text: params[2], image_url: params[5] }]],
  ], calls);
  try {
    const io = fakeIo();
    const s = fakeSocket('member', { id: 201, name: 'Ava' }, io);
    registerHandlers(io, s);
    await fire(s, 'send_message', { flockId: 4101, message_text: '', message_type: 'image', image_url: PNG });

    assert.strictEqual(visionCalls, 1);
    const memberIdx = calls.findIndex((c) => MEMBERSHIP.test(c.text));
    const visionIdx = calls.findIndex((c) => c.text === 'VISION');
    assert.ok(memberIdx >= 0 && visionIdx > memberIdx,
      'the billed call must come after the membership row is confirmed');
    assert.ok(calls.some((c) => /INSERT INTO messages/.test(c.text)));
    assert.ok(io.emitted.some((e) => e.room === 'user:202' && e.event === 'new_message'),
      'delivery fans out per accepted member');
  } finally { restore(); }
});

// --- 2. revoked membership mid-session: emit handlers re-read the database --

test('a socket still sitting in the room cannot send, vote, type or share location once its membership row is gone', async () => {
  __resetRateLimiters();
  let memberRows = [{ id: 1 }];
  const calls = [];
  const restore = mockPool([
    [MEMBERSHIP, () => memberRows],
    [INVISIBLE, []],
  ], calls);
  try {
    const io = fakeIo();
    const s = fakeSocket('kicked', { id: 210, name: 'Kicked' }, io);
    registerHandlers(io, s);

    await fire(s, 'join_flock', 4102);
    assert.ok(s.rooms.has('flock:4102'), 'joined while a member');

    // The membership ends (kick/leave); the socket is still in the room.
    memberRows = [];
    calls.length = 0;

    await fire(s, 'send_message', { flockId: 4102, message_text: 'still here?' });
    assert.deepStrictEqual(errorsOf(s).slice(-1), ['Not a member of this flock']);
    assert.ok(!calls.some((c) => /INSERT INTO messages/.test(c.text)));

    await fire(s, 'vote_venue', { flockId: 4102, venue_name: 'Bar' });
    assert.deepStrictEqual(errorsOf(s).slice(-1), ['Not a member of this flock']);
    assert.ok(!calls.some((c) => /INSERT INTO venue_votes/.test(c.text)));

    await fire(s, 'typing', 4102);
    await fire(s, 'update_location', { flockId: 4102, lat: 1, lng: 2 });
    assert.ok(!io.emitted.some((e) => e.event === 'user_typing'), 'typing must re-read membership at emit time');
    assert.ok(!io.emitted.some((e) => e.event === 'location_update'), 'location must re-read membership at emit time');
  } finally { restore(); }
});

// --- 3. presence cannot outlive a membership the REST path revoked ----------

test('the joiner roster drops presence entries whose socket the room no longer holds', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    [MEMBERSHIP, [{ id: 1 }]],
    [INVISIBLE, []],
  ]);
  try {
    const io = fakeIo();
    const ex = fakeSocket('ex', { id: 501, name: 'Departed' }, io);
    const me = fakeSocket('me', { id: 502, name: 'Me' }, io);
    registerHandlers(io, ex);
    registerHandlers(io, me);

    await fire(ex, 'join_flock', 4209);

    // routes/flocks.js POST /:id/leave: io.in('user:501').socketsLeave(...)
    // removes the socket from the ROOM; the presence cache cannot see it.
    io.sockets.adapter.rooms.get('flock:4209').delete('ex');
    ex.rooms.delete('flock:4209');

    await fire(me, 'join_flock', 4209);
    const roster = me.emitted.find((e) => e.event === 'room_members').payload;
    const ids = roster.members.map((m) => m.userId);
    assert.ok(!ids.includes(501),
      'a member whose room access was revoked over REST must not be shown as online in that flock');
    assert.ok(ids.includes(502), 'the joiner themselves is still listed');
  } finally { restore(); }
});

test('revalidateSession reconciles the presence cache with the rooms the socket actually holds', async () => {
  __resetRateLimiters();
  const jwt = require('jsonwebtoken');
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'authz-sweep-test-secret';
  const token = jwt.sign({ userId: 601, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '24h' });

  const restore = mockPool([
    [MEMBERSHIP, [{ id: 1 }]],
    [INVISIBLE, []],
    [/FROM users WHERE id = \$1/, [{ id: 601, is_banned: false, token_version: 0, name: 'Ghost' }]],
  ]);
  try {
    const ghost = fakeSocket('ghost', { id: 601, name: 'Ghost' }); // no adapter wiring on purpose
    registerHandlers(fakeIo(), ghost);
    await fire(ghost, 'join_flock', 4210);

    // Room access revoked server-side; the socket keeps only its user room.
    ghost.rooms.delete('flock:4210');
    ghost.handshake = { auth: { token } };

    // Without the reconciliation, a joiner whose broadcaster exposes no room
    // set (so the live cross-check cannot run) still saw the ghost as online.
    const witness1 = fakeSocket('w1', { id: 602, name: 'W1' });
    registerHandlers(fakeIo(), witness1);
    await fire(witness1, 'join_flock', 4210);
    const before = witness1.emitted.find((e) => e.event === 'room_members').payload.members.map((m) => m.userId);
    assert.ok(before.includes(601), 'precondition: the stale entry exists until the sweep runs');

    assert.strictEqual(await revalidateSession(ghost), null, 'a healthy session is not revoked by losing a room');

    const witness2 = fakeSocket('w2', { id: 603, name: 'W2' });
    registerHandlers(fakeIo(), witness2);
    await fire(witness2, 'join_flock', 4210);
    const after = witness2.emitted.find((e) => e.event === 'room_members').payload.members.map((m) => m.userId);
    assert.ok(!after.includes(601),
      'the 60s sweep must purge presence entries for rooms the socket no longer holds');
  } finally {
    restore();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

// --- 4. flock-scoped id hygiene: canonical integers, junk refused pre-query --

test('join_flock refuses unparseable ids before any query and joins the canonical room otherwise', async () => {
  __resetRateLimiters();
  const calls = [];
  const restore = mockPool([
    [MEMBERSHIP, [{ id: 1 }]],
    [INVISIBLE, []],
  ], calls);
  try {
    const io = fakeIo();
    const s = fakeSocket('canon', { id: 700, name: 'Canon' }, io);
    registerHandlers(io, s);

    for (const junk of ['abc', '7abc', 1e20, -3, 0, 2.5, {}, [4300], '']) {
      await fire(s, 'join_flock', junk);
    }
    assert.strictEqual(calls.length, 0, 'an id no flock can have must not cost a query');
    assert.deepStrictEqual([...s.rooms].filter((r) => r.startsWith('flock:')), []);

    // Whitespace-padded ids canonicalize instead of minting phantom rooms:
    // Postgres would have trimmed ' 4300 ' to 4300 while the room name kept
    // the spaces, splitting the flock across rooms nobody else is in.
    await fire(s, 'join_flock', ' 4300 ');
    assert.deepStrictEqual([...s.rooms].filter((r) => r.startsWith('flock:')), ['flock:4300']);
    const roster = s.emitted.find((e) => e.event === 'room_members').payload;
    assert.strictEqual(roster.flockId, 4300, 'the echoed id is the canonical integer App.js compares with ===');
  } finally { restore(); }
});

test('typing echoes the canonical integer id and never a raw client spelling', async () => {
  __resetRateLimiters();
  const calls = [];
  const restore = mockPool([
    [/user_id != \$2/, [{ user_id: 702 }]],
    [MEMBERSHIP, [{ id: 1 }]],
    [INVISIBLE, []],
  ], calls);
  try {
    const io = fakeIo();
    const s = fakeSocket('typer', { id: 701, name: 'Typer' }, io);
    registerHandlers(io, s);

    await fire(s, 'typing', '4301   ');
    const typing = io.emitted.find((e) => e.event === 'user_typing');
    assert.strictEqual(typing.payload.flockId, 4301,
      'the raw spelling used to be fanned out verbatim to every member');
    assert.strictEqual(typing.room, 'user:702');

    calls.length = 0;
    io.emitted.length = 0;
    await fire(s, 'typing', '4301abc');
    assert.strictEqual(calls.length, 0, 'junk ids are refused before the membership query');
    assert.strictEqual(io.emitted.length, 0);
  } finally { restore(); }
});

test('leave_flock detaches on any id but announces only for a real membership', async () => {
  __resetRateLimiters();
  let memberRows = [{ id: 1 }];
  const calls = [];
  const restore = mockPool([
    [MEMBERSHIP, () => memberRows],
    [INVISIBLE, []],
  ], calls);
  try {
    const io = fakeIo();
    const s = fakeSocket('leaver', { id: 703, name: 'Leaver' }, io);
    registerHandlers(io, s);

    await fire(s, 'leave_flock', 'not-a-flock');
    assert.strictEqual(calls.length, 0, 'an impossible id has nothing to verify or announce');
    assert.ok(!s.emitted.some((e) => e.event === 'member_offline'));

    // A non-member naming a real id detaches silently (round 13 rule).
    memberRows = [];
    await fire(s, 'leave_flock', 4302);
    assert.ok(!s.emitted.some((e) => e.event === 'member_offline'),
      'a stranger must not push presence events into a guessed flock');
  } finally { restore(); }
});

test('stop_sharing_location requires membership and targets the canonical room', async () => {
  __resetRateLimiters();
  let memberRows = [];
  const restore = mockPool([
    [MEMBERSHIP, () => memberRows],
    [INVISIBLE, []],
  ]);
  try {
    const io = fakeIo();
    const s = fakeSocket('sharer', { id: 704, name: 'Sharer' }, io);
    registerHandlers(io, s);

    await fire(s, 'stop_sharing_location', { flockId: 4303 });
    assert.ok(!s.emitted.some((e) => e.event === 'member_stopped_sharing'), 'non-member: silent');

    memberRows = [{ id: 1 }];
    await fire(s, 'stop_sharing_location', { flockId: '4303' });
    const stop = s.emitted.find((e) => e.event === 'member_stopped_sharing');
    assert.strictEqual(stop.target, 'flock:4303', 'string ids resolve to the canonical room');
  } finally { restore(); }
});

// --- 5. update_location: DB-derived fan-out, blocks, no client redirection --

test('update_location fans out only to accepted members and never to blocked peers', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    [/user_id != \$2/, [{ user_id: 801 }, { user_id: 802 }]],
    [MEMBERSHIP, [{ id: 1 }]],
    [INVISIBLE, [{ id: 802 }]],
  ]);
  try {
    const io = fakeIo();
    const s = fakeSocket('walker', { id: 800, name: 'Walker' }, io);
    registerHandlers(io, s);

    await fire(s, 'update_location', { flockId: 4304, lat: 40.7, lng: -74.0 });
    const targets = io.emitted.filter((e) => e.event === 'location_update').map((e) => e.room);
    assert.deepStrictEqual(targets, ['user:801'],
      'recipients come from the flock_members read at emit time, minus blocked pairs — the payload cannot be redirected by a client-supplied id');
  } finally { restore(); }
});

test('update_location refuses coordinates that are not coordinates', async () => {
  __resetRateLimiters();
  const calls = [];
  const restore = mockPool([[MEMBERSHIP, [{ id: 1 }]], [INVISIBLE, []], [/user_id != \$2/, []]], calls);
  try {
    const io = fakeIo();
    const s = fakeSocket('nan', { id: 803, name: 'NaN' }, io);
    registerHandlers(io, s);
    for (const [lat, lng] of [[NaN, 0], [0, Infinity], ['40', '-74'], [91, 0], [0, 181], [null, null]]) {
      await fire(s, 'update_location', { flockId: 4305, lat, lng });
    }
    assert.strictEqual(io.emitted.filter((e) => e.event === 'location_update').length, 0);
    assert.strictEqual(calls.length, 0, 'bad coordinates are refused before the membership query');
  } finally { restore(); }
});

// --- 6. select_venue: creator-only, pinned ----------------------------------

test('select_venue refuses everyone but the creator and block-filters the announcement', async () => {
  __resetRateLimiters();
  const calls = [];
  const restore = mockPool([
    [/SELECT creator_id FROM flocks WHERE id = \$1/, [{ creator_id: 900 }]],
    [/UPDATE flocks/, []],
    [INVISIBLE, [{ id: 905 }]],
  ], calls);
  try {
    const io = fakeIo();
    const member = fakeSocket('notcreator', { id: 901, name: 'Member' }, io);
    registerHandlers(io, member);
    await fire(member, 'select_venue', { flockId: 4306, venue_name: 'Bar' });
    assert.deepStrictEqual(errorsOf(member), ['Only the flock creator can select a venue']);
    assert.ok(!calls.some((c) => /UPDATE flocks/.test(c.text)), 'no write for a non-creator');

    const creator = fakeSocket('creator', { id: 900, name: 'Creator' }, io);
    registerHandlers(io, creator);
    await fire(creator, 'select_venue', { flockId: 4306, venue_name: 'Bar' });
    assert.ok(calls.some((c) => /UPDATE flocks/.test(c.text)));
    const announced = io.emitted.find((e) => e.event === 'venue_selected');
    assert.strictEqual(announced.room, 'flock:4306');
    assert.deepStrictEqual(announced.excluded, ['user:905'],
      'a member who blocked the creator must not get the toast naming them');
  } finally { restore(); }
});

// --- 7. DMs: blocks and relationships hold at the socket layer --------------

test('send_dm refuses a blocked pair and a stranger, and persists nothing either way', async () => {
  __resetRateLimiters();
  let blockRows = [{ '?column?': 1 }];
  const calls = [];
  const restore = mockPool([
    [BLOCK_PAIR, () => blockRows],
    [RELATIONSHIP, []],
  ], calls);
  try {
    const s = fakeSocket('dm', { id: 1001, name: 'Sender' });
    registerHandlers(fakeIo(), s);

    await fire(s, 'send_dm', { receiverId: 1002, message_text: 'hi' });
    assert.deepStrictEqual(errorsOf(s), ['You can no longer message this user.']);

    blockRows = [];
    await fire(s, 'send_dm', { receiverId: 1003, message_text: 'hi' });
    assert.deepStrictEqual(errorsOf(s).slice(-1), [NOT_CONNECTED_MESSAGE],
      'no relationship, no DM — the REST route already refuses this with a 403');

    assert.ok(!calls.some((c) => /INSERT INTO direct_messages/.test(c.text)));
    assert.ok(!calls.some((c) => /SELECT id, name FROM users/.test(c.text)),
      'the receiver-exists lookup must not run for a refused sender — it would be a user-id oracle');
  } finally { restore(); }
});

test('dm_react refuses hidden messages and non-participants', async () => {
  __resetRateLimiters();
  const calls = [];
  let dmRows = [];
  const restore = mockPool([
    [/COALESCE\(is_hidden, false\) = false/, () => dmRows],
  ], calls);
  try {
    const io = fakeIo();
    const s = fakeSocket('reactor', { id: 1100, name: 'Reactor' }, io);
    registerHandlers(io, s);

    // Moderator-hidden DM: same 404-shaped silence as the REST twin.
    await fire(s, 'dm_react', { dmId: 5, emoji: 'x' });
    assert.ok(!calls.some((c) => /INSERT INTO dm_emoji_reactions/.test(c.text)));
    assert.ok(!s.emitted.some((e) => e.event === 'dm_reaction_added'));

    // A DM between two OTHER people: the participant check refuses it.
    dmRows = [{ sender_id: 1101, receiver_id: 1102 }];
    await fire(s, 'dm_react', { dmId: 6, emoji: 'x' });
    assert.ok(!calls.some((c) => /INSERT INTO dm_emoji_reactions/.test(c.text)));
    assert.ok(!s.emitted.some((e) => e.event === 'dm_reaction_added'));
  } finally { restore(); }
});

test('dm_vote_venue and dm_pin_venue refuse a pair with no relationship before any write', async () => {
  __resetRateLimiters();
  const calls = [];
  const restore = mockPool([
    [BLOCK_PAIR, []],
    [RELATIONSHIP, []],
  ], calls);
  try {
    const s = fakeSocket('pinner', { id: 1200, name: 'Pinner' });
    registerHandlers(fakeIo(), s);

    await fire(s, 'dm_vote_venue', { receiverId: 1201, venue_name: 'Bar' });
    await fire(s, 'dm_pin_venue', { receiverId: 1201, venue_name: 'Bar' });
    assert.ok(!calls.some((c) => /dm_venue_votes|dm_pinned_venues/.test(c.text)),
      'dm_pinned_venues upserts on the PAIR — an outsider write overwrites two other people\'s pin');
    assert.ok(!s.emitted.some((e) => e.event === 'dm_new_vote' || e.event === 'dm_venue_pinned'));
  } finally { restore(); }
});

test('ephemeral DM events (typing, location) enforce blocks at the socket layer', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    [BLOCK_PAIR, [{ '?column?': 1 }]],
  ]);
  try {
    const s = fakeSocket('eph', { id: 1301, name: 'Eph' });
    registerHandlers(fakeIo(), s);

    await fire(s, 'dm_typing', { receiverId: 1302 });
    await fire(s, 'dm_share_location', { receiverId: 1302, lat: 1, lng: 2 });
    await fire(s, 'dm_stop_typing', { receiverId: 1302 });
    await fire(s, 'dm_stop_sharing_location', { receiverId: 1302 });
    assert.strictEqual(s.emitted.length, 0,
      'a blocked pair exchanges nothing, not even typing dots or a location ping');
    // These handlers deliberately stop at the block check (no relationship
    // query per keystroke — the round 13 note in handlers.js records the
    // trade). The PERSISTING DM handlers above all require the relationship.
  } finally { restore(); }
});

// --- 8. friend events: verified state only, blocks first --------------------

test('friend_request_sent between a blocked pair is refused before the row is even read', async () => {
  __resetRateLimiters();
  const calls = [];
  const restore = mockPool([
    [BLOCK_PAIR, [{ '?column?': 1 }]],
    [/FROM friendships/, [{ '?column?': 1 }]],
  ], calls);
  try {
    const io = fakeIo();
    const s = fakeSocket('friend', { id: 1401, name: 'Friend' }, io);
    registerHandlers(io, s);
    await fire(s, 'friend_request_sent', { toUserId: 1402 });
    assert.ok(!io.emitted.some((e) => e.event === 'friend_request_received'));
    assert.ok(!calls.some((c) => /FROM friendships/.test(c.text)),
      'the block check comes first, so the pending-row lookup never runs');
  } finally { restore(); }
});

test('friend_request_response relays only an outcome the database actually holds', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    [BLOCK_PAIR, []],
    [/FROM friendships/, []],
  ]);
  try {
    const io = fakeIo();
    const s = fakeSocket('liar', { id: 1403, name: 'Liar' }, io);
    registerHandlers(io, s);
    await fire(s, 'friend_request_response', { toUserId: 1404, action: 'accepted' });
    assert.ok(!io.emitted.some((e) => e.event === 'friend_request_responded'),
      'a claimed acceptance with no matching row must not be relayed');
  } finally { restore(); }
});

// --- 9. flock_invite: member-only, canonical ids ----------------------------

test('flock_invite requires membership and canonicalizes every id it touches', async () => {
  __resetRateLimiters();
  let memberRows = [];
  const calls = [];
  const restore = mockPool([
    [/status = 'invited'/, [{ user_id: 42 }]],
    [MEMBERSHIP, () => memberRows],
    [/SELECT id, name FROM flocks WHERE id = \$1/, [{ id: 4307, name: 'Trip' }]],
    [BLOCK_PAIR, []],
    [INVISIBLE, []],
  ], calls);
  try {
    const io = fakeIo();
    const s = fakeSocket('inviter', { id: 1500, name: 'Host' }, io);
    registerHandlers(io, s);

    await fire(s, 'flock_invite', { flockId: 4307, invitedUserIds: [42] });
    assert.deepStrictEqual(errorsOf(s), ['Not a member of this flock']);

    memberRows = [{ id: 1 }];
    await fire(s, 'flock_invite', { flockId: '4307', invitedUserIds: [42, 1e20, 0, 'junk'] });
    const invitedParams = calls.find((c) => /status = 'invited'/.test(c.text)).params[1];
    assert.deepStrictEqual(invitedParams, [42],
      '1e20 passes Number.isInteger and 0 names nobody — asId refuses both before Postgres sees them');
    const toast = io.emitted.find((e) => e.event === 'flock_invite_received');
    assert.strictEqual(toast.room, 'user:42');
    assert.strictEqual(toast.payload.flockId, 4307, 'string ids go out as the canonical integer');
    const echo = s.emitted.find((e) => e.event === 'flock_members_invited');
    assert.strictEqual(echo.target, 'flock:4307');
    assert.deepStrictEqual(echo.payload.invitedUserIds, [42], 'only the DB-confirmed list is echoed');
  } finally { restore(); }
});

// --- 10. crowd_update: verified claim on the exact venue, pinned ------------

test('crowd_update refuses an unverified account even with a venue_owner role', async () => {
  __resetRateLimiters();
  const restore = mockPool([
    [/FROM venue_profiles WHERE user_id = \$1/, []],
  ]);
  try {
    const io = fakeIo();
    const s = fakeSocket('poser', { id: 1600, name: 'Poser', role: 'venue_owner' }, io);
    registerHandlers(io, s);
    await fire(s, 'crowd_update', { venue_id: 'ChIJnotMyVenue0001', level: 'packed' });
    assert.deepStrictEqual(errorsOf(s), ['Only the verified owner can update crowd levels']);
    assert.ok(!io.emitted.some((e) => e.event === 'crowd_update'),
      'role is self-assigned at onboarding; only the verified claim on this exact venue authorizes');
  } finally { restore(); }
});
