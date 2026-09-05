// Run: node --test  (from backend/)
//
// Round 18 — the socket half of the takedown, and the block filters that were
// still one-sided on that transport.
//
// The recurring shape: one job, two transports, and only one of them gains the
// guard. This file pins the socket side of four such pairs.
//
//   1. TAKEDOWN. POST /api/dm/messages/:id/react refuses a moderator-hidden DM
//      with a 404 (__tests__/takedownLeaks.test.js). The socket twin looked the
//      message up with no is_hidden predicate at all, so the same action simply
//      succeeded over the other transport — a reaction row written against
//      taken-down content, and a `dm_reaction_added` naming the reactor pushed
//      at the person the takedown protects. Reaction REMOVAL stays allowed on
//      both transports: cleaning up after a takedown is not interaction.
//   2. join_flock held the one block filter on the file that failed OPEN. An
//      unreadable block list became an empty one, and the handler announced
//      `member_joined` by name to everyone — blocked users included — and
//      handed the joiner a roster containing them.
//   3. `flock_members_invited` and `venue_selected` both name an actor and both
//      reached the flock room unfiltered, while the REST producers of the same
//      class of event (routes/flocks.js) fan out block-filtered.
//   4. The one-shot relay ceiling refused EVERYONE once its global map filled,
//      and one account could fill it alone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'socket-takedown-parity-secret';

const pool = require('../config/database');

// Destructured at module load by sockets/handlers.js — replace first.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const {
  registerHandlers,
  __resetRateLimiters,
  alreadyRelayed,
  RELAY_NEW_KEYS_PER_USER,
} = require('../sockets/handlers');

// --- harness ---------------------------------------------------------------
//
// Same shape as __tests__/dmSocketParity.test.js: a route maps a SQL pattern to
// the ROWS it returns, and an unscripted query is a loud failure rather than a
// silent empty result. A route may also return a rejected promise, to model a
// database that cannot answer — which is the whole point of the fail-closed
// assertions below.

let calls = [];
let routes = [];

function dispatch(sql, params) {
  calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, rows] of routes) {
    if (re.test(sql)) {
      const out = typeof rows === 'function' ? rows(params || [], String(sql)) : rows;
      if (out && typeof out.then === 'function') return out;
      return Promise.resolve({ rows: out });
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 110)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return Promise.resolve({ rows: [] });
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
    // `except` records what it was handed, so a test can assert a broadcast was
    // actually narrowed rather than merely sent.
    to(room) {
      const op = {
        excepted: null,
        except(r) { op.excepted = [].concat(r); return op; },
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
        except(r) { op.excepted = [].concat(r); return op; },
        emit(event, payload) { emitted.push({ room, event, payload, excepted: op.excepted }); },
      };
      return op;
    },
  };
}

function connect(user = { id: 1, name: 'Ava' }, socketId = 's1') {
  __resetRateLimiters();
  calls = [];
  routes = [];
  const io = fakeIo();
  const socket = fakeSocket(socketId, user);
  registerHandlers(io, socket);
  socket.emitted.length = 0; // drop the connect-time bookkeeping
  return { io, socket };
}

const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);
const sqlFor = (re) => calls.find((c) => re.test(c.sql));
const ran = (re) => calls.filter((c) => re.test(c.sql));
const HANDLERS_SRC = fs.readFileSync(path.join(__dirname, '..', 'sockets', 'handlers.js'), 'utf8');

const DM_LOOKUP = /SELECT sender_id, receiver_id FROM direct_messages/;
const INVISIBLE_IDS = /blocked_id AS id FROM user_blocks/; // getInvisibleUserIds

// A direct_messages lookup that behaves the way Postgres would: the row comes
// back only when the statement did NOT ask for a visible one. The PREDICATE is
// what refuses it, so a lookup that forgot the predicate would see the row.
// Same trick __tests__/takedownLeaks.test.js uses on the REST side.
const dmRow = [{ sender_id: 2, receiver_id: 1 }];
const hiddenDm = (_p, sql) => (/COALESCE\(is_hidden, false\) = false/.test(sql) ? [] : dmRow);

// ---------------------------------------------------------------------------
// 1. The takedown, on the socket transport
// ---------------------------------------------------------------------------

test('dm_react asks for the takedown flag, exactly as its REST twin does', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [DM_LOOKUP, dmRow],
    [/FROM user_blocks/, []],
    [/INSERT INTO dm_emoji_reactions/, []],
  ];

  await fire(socket, 'dm_react', { dmId: 5, emoji: '🔥' });

  const lookup = sqlFor(DM_LOOKUP);
  assert.ok(lookup, 'the message lookup still runs');
  assert.match(
    lookup.sql,
    /COALESCE\(is_hidden, false\) = false/,
    'POST /api/dm/messages/:id/react has this predicate; the socket must not be the way around it'
  );
});

test('a moderator-hidden DM is not reactable over the socket', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [DM_LOOKUP, hiddenDm],
    [/FROM user_blocks/, []],
    [/INSERT INTO dm_emoji_reactions/, []],
  ];

  await fire(socket, 'dm_react', { dmId: 5, emoji: '🔥' });

  assert.strictEqual(ran(/INSERT INTO dm_emoji_reactions/).length, 0,
    'no reaction row may be written against taken-down content');
  assert.strictEqual(io.emitted.length, 0);
  assert.strictEqual(socket.emitted.filter((e) => e.event === 'dm_reaction_added').length, 0,
    'and nobody is told a reactor interacted with a message that was removed');
});

test('a visible DM is still reactable — the predicate is a filter, not an off switch', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [DM_LOOKUP, dmRow], // a row that is not hidden: the predicate lets it through
    [/FROM user_blocks/, []],
    [/INSERT INTO dm_emoji_reactions/, []],
  ];

  await fire(socket, 'dm_react', { dmId: 5, emoji: '🔥' });

  assert.strictEqual(ran(/INSERT INTO dm_emoji_reactions/).length, 1);
  // Still two copies, counterpart plus the reactor's own. The reactor's leaves
  // through io rather than back down this socket, because the account can hold
  // several and all of them show the same thread; __tests__/dmSocketParity.test.js
  // pins that. The takedown question here is only whether anything is sent at
  // all, so both destinations are counted together.
  const announced = socket.emitted.filter((e) => e.event === 'dm_reaction_added')
    .concat(io.emitted.filter((e) => e.event === 'dm_reaction_added'));
  assert.strictEqual(announced.length, 2, 'counterpart room + the reactor\'s own account room');
});

test('removing a reaction after a takedown stays possible, on both transports', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [DM_LOOKUP, hiddenDm], // returns the row, because this path asks no predicate
    [/FROM user_blocks/, []],
    [/DELETE FROM dm_emoji_reactions/, []],
  ];

  await fire(socket, 'dm_remove_react', { dmId: 5, emoji: '🔥' });

  const lookup = sqlFor(DM_LOOKUP);
  assert.ok(!/is_hidden/.test(lookup.sql),
    'cleaning up after a takedown is not interaction — the REST DELETE twin does not filter either');
  assert.strictEqual(ran(/DELETE FROM dm_emoji_reactions/).length, 1,
    'someone who reacted before the takedown must still be able to take it back');
});

test('the reply-target lookup keeps its predicate, so the sweep stays swept', () => {
  // send_dm may not quote a hidden message back into the thread. This has been
  // right since the takedown audit; it is asserted here because the DM lookups
  // are the entire population of moderatable reads on this file, and a
  // regression in either one is the same bug.
  assert.match(HANDLERS_SRC, /COALESCE\(dm\.is_hidden, false\) = false/,
    'send_dm reply targets must still exclude hidden messages');

  // The other tables that carry is_hidden. Three of them are simply never read
  // from this file, so direct_messages and guest_rsvps are the whole sweep.
  for (const table of ['FROM messages', 'FROM stories', 'FROM venue_reviews', 'FROM venue_promotions']) {
    assert.ok(!HANDLERS_SRC.includes(table),
      `${table} appeared in sockets/handlers.js — it carries is_hidden, so it needs the predicate too`);
  }
  // guest_rsvps used to be read by this file's own copy of the vote tally.
  // That copy is gone: the handler imports routes/venues.js collectVoteRows
  // and tailorVotes, so the one read of guest_rsvps on the socket path is the
  // same statement REST runs. The sweep follows the import rather than
  // assuming the SQL still lives here, and pins both halves: this file makes
  // no direct read of its own, and the shared read carries the takedown flag,
  // so a guest whose RSVP a moderator removed cannot move the venue vote from
  // either producer.
  const guestReads = HANDLERS_SRC.split('\n').filter((l) => /guest_rsvps/.test(l) && !/^\s*\/\//.test(l.trim()));
  assert.strictEqual(guestReads.length, 0,
    'sockets/handlers.js grew its own guest_rsvps read again; the tally is routes/venues.js collectVoteRows, import it');
  assert.match(HANDLERS_SRC, /require\('\.\.\/routes\/venues'\)/, 'the socket tally must come from routes/venues.js');
  assert.match(HANDLERS_SRC, /const rows = await collectVoteRows\(flockId\)/, 'vote_venue must call the shared tally');
  const VENUES_SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'venues.js'), 'utf8');
  assert.match(VENUES_SRC, /JOIN guest_rsvps gr[\s\S]{0,200}?COALESCE\(gr\.is_hidden, false\) = false/,
    'the shared guest tally must carry the takedown predicate');
});

// ---------------------------------------------------------------------------
// 2. join_flock: the block filter that failed open
// ---------------------------------------------------------------------------

test('join_flock announces nothing when the block list cannot be read', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM user_blocks/, () => Promise.reject(new Error('connection terminated'))],
  ];

  await fire(socket, 'join_flock', 42);

  assert.ok(socket.rooms.has('flock:42'),
    'the room join carries no identity — a database blip must not strand a member outside their own flock');
  assert.strictEqual(socket.emitted.filter((e) => e.event === 'member_joined').length, 0,
    'an unreadable block list is not an empty one; this used to announce the joiner by name to everyone');
  assert.strictEqual(socket.emitted.filter((e) => e.event === 'room_members').length, 0,
    'and the roster would have handed the joiner every account they had blocked');
});

test('join_flock still announces normally when the block list answers', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [INVISIBLE_IDS, [{ id: 9 }]],
  ];

  await fire(socket, 'join_flock', 42);

  const joined = socket.emitted.find((e) => e.event === 'member_joined');
  assert.ok(joined, 'the fail-closed path must not have swallowed the happy path');
  assert.deepStrictEqual(joined.excepted, ['user:9'], 'blocked users are excluded, not the whole room');
  assert.ok(socket.emitted.some((e) => e.event === 'room_members'));
});

// ---------------------------------------------------------------------------
// 3. Events that name an actor
// ---------------------------------------------------------------------------

test('flock_members_invited does not hand the inviter name to someone who blocked them', async () => {
  const { socket } = connect({ id: 70, name: 'Host' });
  routes = [
    [/status = 'invited'/, [{ user_id: 42 }]],
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/FROM flocks WHERE id = \$1/, [{ id: 4104, name: 'Trip' }]],
    [INVISIBLE_IDS, [{ id: 91 }]],
    [/FROM user_blocks/, []], // isBlockedBetween, per invitee
  ];

  await fire(socket, 'flock_invite', { flockId: 4104, invitedUserIds: [42] });

  const echo = socket.emitted.find((e) => e.event === 'flock_members_invited');
  assert.ok(echo, 'the room still hears about the invite');
  assert.strictEqual(echo.target, 'flock:4104', 'delivery scope is unchanged');
  assert.deepStrictEqual(echo.excepted, ['user:91'],
    'the payload carries invitedBy.name — the REST twin has filtered this since the takedown audit');
});

test('venue_selected does not hand the creator name to someone who blocked them', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/SELECT creator_id FROM flocks/, [{ creator_id: 1 }]],
    [/UPDATE flocks/, []],
    [INVISIBLE_IDS, [{ id: 9 }]],
  ];

  await fire(socket, 'select_venue', { flockId: 42, venue_name: "Joe's Bar" });

  const selected = io.emitted.find((e) => e.event === 'venue_selected');
  assert.ok(selected);
  assert.strictEqual(selected.room, 'flock:42');
  assert.deepStrictEqual(selected.excepted, ['user:9'],
    'selected_by names the creator; flock_updated, the same kind of event, is already filtered on the REST side');
});

test('an unreadable block list drops the venue announcement rather than leaking it', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/SELECT creator_id FROM flocks/, [{ creator_id: 1 }]],
    [/UPDATE flocks/, []],
    [/FROM user_blocks/, () => Promise.reject(new Error('connection terminated'))],
  ];

  await fire(socket, 'select_venue', { flockId: 42, venue_name: "Joe's Bar" });

  assert.strictEqual(io.emitted.filter((e) => e.event === 'venue_selected').length, 0);
  // The venue is still confirmed in the database. What a blocked member loses
  // is the live toast, not the plan — the next REST read supplies it.
  assert.strictEqual(ran(/UPDATE flocks/).length, 1);
});

test('no identity-bearing broadcast on this file reaches a flock room unfiltered', () => {
  // A grep, because the assertions above only cover the handlers they drive.
  // Every `flock:` room emit has to go through broadcastExcluding, which takes
  // the block list; a room operator chained straight into `.emit(` cannot have
  // been filtered by anything.
  const offenders = HANDLERS_SRC.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /^(io|socket)\.to\(`flock:/.test(line) && /\.emit\(/.test(line));
  assert.deepStrictEqual(offenders, [],
    'a flock-room emit that is not routed through broadcastExcluding is not block-aware');
});

// ---------------------------------------------------------------------------
// 4. The one-shot relay ceiling is bounded PER ACCOUNT, not only globally
// ---------------------------------------------------------------------------
//
// Asserted against alreadyRelayed directly. Driving it through the handler
// cannot reach the ceiling: friend_event is metered at 40 per 10 seconds per
// account, so filling the shared map is an 80-minute exercise in real time and
// a test that fires 400 events only proves the rate limiter works.

test('one account cannot claim an unbounded share of the process-global relay map', () => {
  __resetRateLimiters();

  let delivered = 0;
  for (let i = 0; i < RELAY_NEW_KEYS_PER_USER * 3; i++) {
    if (!alreadyRelayed(`req|1|${1000 + i}`, 1)) delivered++;
  }

  // Before the per-account bound, ~20000 of these bought a rolling ten-minute
  // outage of friend-request delivery for EVERY user, because a full map makes
  // alreadyRelayed refuse everyone. The global cap's failure mode is global, so
  // it must not be the mechanism that a single actor gets to trigger.
  assert.strictEqual(delivered, RELAY_NEW_KEYS_PER_USER,
    `one account claimed ${delivered} relay slots`);
});

test('one account spending its relay budget does not silence anybody else', () => {
  __resetRateLimiters();

  for (let i = 0; i < RELAY_NEW_KEYS_PER_USER * 3; i++) alreadyRelayed(`req|1|${2000 + i}`, 1);

  assert.strictEqual(alreadyRelayed('req|2|9', 2), false,
    'the budget is per actor — a spammer must not be able to mute the product');
});

test('a suppressed re-emit is not charged to the budget genuine requests draw on', () => {
  __resetRateLimiters();

  // The harassment case: one legitimately pending request, re-fired forever.
  // It is refused by the pair key, and must not also burn the account's ability
  // to friend-request anyone else.
  assert.strictEqual(alreadyRelayed('req|1|9', 1), false, 'the first delivery goes through');
  for (let i = 0; i < 500; i++) {
    assert.strictEqual(alreadyRelayed('req|1|9', 1), true, 'and never again inside the window');
  }

  let delivered = 0;
  for (let i = 0; i < RELAY_NEW_KEYS_PER_USER - 1; i++) {
    if (!alreadyRelayed(`req|1|${3000 + i}`, 1)) delivered++;
  }
  assert.strictEqual(delivered, RELAY_NEW_KEYS_PER_USER - 1,
    'the 500 refusals cost nothing; only the two real targets did');
});

// ---------------------------------------------------------------------------
// 5. A constant that is justified by a number in another file
// ---------------------------------------------------------------------------

test('the crowd tie margin still sits inside the error band the model reports', () => {
  // services/crowdEngine.js sets TIE_MARGIN (and, deliberately equal to it,
  // MAX_SINGLE_REPORT_LEVERAGE) from the shipped model's holdout error. The
  // justification used to quote "~58% of predictions within 15" from a model
  // that has since been replaced — the metadata now says 85.1%. A prose number
  // sourced from another file rots silently, so it is checked here: the margin
  // must be larger than the typical (median) error, or it acts on noise, and no
  // larger than the model's RMSE, or it ignores real differences.
  let meta;
  try {
    meta = require('../scripts/ml/models/model_metadata.json');
  } catch (_) {
    return; // model artifacts are optional in a checkout without them
  }
  const holdout = meta.evaluation?.holdout;
  if (!holdout) return;

  const { MAX_SINGLE_REPORT_LEVERAGE } = require('../services/crowdEngine');
  assert.ok(
    MAX_SINGLE_REPORT_LEVERAGE <= holdout.mae,
    `margin ${MAX_SINGLE_REPORT_LEVERAGE} exceeds the holdout MAE ${holdout.mae}: it would act on differences the model cannot resolve`
  );
  assert.ok(
    MAX_SINGLE_REPORT_LEVERAGE >= holdout.mae / 2,
    `margin ${MAX_SINGLE_REPORT_LEVERAGE} has fallen far below the holdout MAE ${holdout.mae}: re-derive it rather than leaving it stale`
  );
});

// ---------------------------------------------------------------------------
// 6. Two more places where one of a pair had the guard
// ---------------------------------------------------------------------------

test('send_dm requires the relationship its REST twin requires', async () => {
  // POST /api/dm/:userId answers 403 NOT_CONNECTED for two accounts with no
  // accepted friendship and no existing conversation — otherwise it is a
  // directory walk that leaves a message in a stranger's inbox for every id
  // that resolves. That gate landed on REST while send_dm carried a comment
  // arguing, from the old REST behaviour, that it should NOT have one. The
  // socket is the transport the app actually sends on, so the hole had simply
  // moved to the primary path.
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/SELECT 1 WHERE EXISTS/, []], // no friendship, no prior DM
    [/SELECT id, name FROM users WHERE id = \$1/, [{ id: 7, name: 'Stranger' }]],
    [/INSERT INTO direct_messages/, [{ id: 99 }]],
  ];

  await fire(socket, 'send_dm', { receiverId: 7, message_text: 'hey' });

  assert.strictEqual(ran(/INSERT INTO direct_messages/).length, 0,
    'no relationship, no message');
  const err = socket.emitted.find((e) => e.event === 'error');
  assert.ok(err && /connected/i.test(err.payload.message),
    'and the same one refusal covers "no such user" and "not connected"');
});

test('the relationship gate is checked before anything that costs money', async () => {
  // moderateImage is a billed Google Vision call. A stranger who cannot deliver
  // the message must not be able to spend on finding that out.
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/SELECT 1 WHERE EXISTS/, []],
  ];

  await fire(socket, 'send_dm', {
    receiverId: 7,
    message_type: 'image',
    image_url: 'data:image/png;base64,AAAA',
  });

  assert.strictEqual(ran(/INSERT INTO direct_messages/).length, 0);
  assert.ok(!calls.some((c) => /SELECT id, name FROM users/.test(c.sql)),
    'it bails at the relationship check, before the receiver lookup and the Vision call');
});

test('send_dm still delivers between two people who are connected', async () => {
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/SELECT 1 WHERE EXISTS/, [{ '?column?': 1 }]],
    [/SELECT id, name FROM users WHERE id = \$1/, [{ id: 7, name: 'Bo' }]],
    [/INSERT INTO direct_messages/, [{ id: 99, sender_id: 1, receiver_id: 7 }]],
  ];

  await fire(socket, 'send_dm', { receiverId: 7, message_text: 'hi' });

  assert.strictEqual(ran(/INSERT INTO direct_messages/).length, 1,
    'the gate is a filter, not an off switch');
  assert.ok(socket.emitted.some((e) => e.event === 'new_dm' && e.target === 'user:7'));
});

test('crowd_update applies the same id rule join_venue does', async () => {
  // Two handlers on this file decide what a valid venue room is. join_venue
  // refuses anything that is not shaped like a Google place id before it will
  // subscribe; this one checked only that the value was truthy, and the
  // `role === 'admin'` bypass below skips the venue_profiles claim that is
  // otherwise what guarantees a real id.
  const { io, socket } = connect({ id: 33, name: 'Root', role: 'admin' });
  routes = [[/FROM venue_profiles/, [{ '?column?': 1 }]]];

  for (const bad of ['x', 'x'.repeat(300), "'; DROP TABLE users--", 42, { id: 'a' }]) {
    // eslint-disable-next-line no-await-in-loop
    await fire(socket, 'crowd_update', { venue_id: bad, level: 'busy' });
  }

  assert.strictEqual(calls.length, 0, 'a malformed id is refused before any query');
  assert.strictEqual(io.emitted.length, 0, 'and no room name is minted from it');
});

test('the socket vote tally counts what the REST tally counts', async () => {
  // `new_vote` has two producers: this handler and routes/venues.js, whose own
  // comment says "every tally in this file comes from here so the REST
  // responses, the socket broadcasts and the GET all agree". They did not.
  const { socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 1 }]],
    [/pg_advisory_xact_lock/, []],
    [/DELETE FROM venue_votes/, []],
    [/INSERT INTO venue_votes/, []],
    // routes/venues.js collectVoteRows runs two statements: members, then
    // guests. The socket handler calls it now instead of carrying a one-CTE
    // copy, so the fake answers each statement on its own.
    [/FROM venue_votes vv/, [
      { venue_name: "Joe's Bar", venue_id: 'abc', member_count: 1, voter_rows: [{ id: 1, name: 'Ava' }] },
    ]],
    // A venue only guests have voted for still has to appear.
    [/FROM guest_votes gv/, [{ venue_name: 'The Diner', guest_count: 3 }]],
    [/FROM flock_members WHERE flock_id = \$1 AND status/, [{ user_id: 1 }]],
    [/FROM user_blocks/, []],
  ];

  await fire(socket, 'vote_venue', { flockId: 42, venue_name: "Joe's Bar", venue_id: 'abc' });

  const tally = sqlFor(/FROM venue_votes vv/);
  assert.match(tally.sql, /JOIN flock_members fm[\s\S]*?fm\.status = 'accepted'/,
    "round 17 stopped a departed member's vote counting on REST; leaving, then voting from a second account, skewed the live tally instead");
  const guests = sqlFor(/FROM guest_votes gv/);
  assert.ok(guests, 'the REST tally adds guest-link votes; a live tally that ignores them ranks venues differently');
  assert.match(guests.sql, /COALESCE\(gr\.is_hidden, false\) = false/,
    'and a guest whose RSVP was taken down must not move either tally');

  const emitted = socket.emitted.find((e) => e.event === 'new_vote');
  const byName = Object.fromEntries(emitted.payload.votes.map((v) => [v.venue_name, v]));
  assert.strictEqual(byName["Joe's Bar"].vote_count, 1);
  // CAPPED, exactly as REST caps it. This line used to assert 3 and its
  // message said "as they do on REST", which was the defect: REST weighs guest
  // votes at min(guests, member turnout), the defence against one link-holder
  // minting fifty guest RSVPs, and the socket added them raw. With one member
  // vote cast the cap is 1, so three guests weigh 1 here and on GET /votes.
  assert.strictEqual(byName['The Diner'].vote_count, 1,
    'guest votes are capped at the member turnout on REST and must be here too');
  assert.strictEqual(byName['The Diner'].guest_count, 3, 'and guest_count is on the wire so the UI can say "+3 guests"');
  assert.strictEqual(typeof byName["Joe's Bar"].vote_count, 'number',
    'COUNT(*) comes back from node-pg as a string for a bigint; the REST payload carries a number');
  // Blended totals tie at 1, and tailorVotes breaks the tie toward members.
  assert.deepStrictEqual(emitted.payload.votes.map((v) => v.venue_name), ["Joe's Bar", 'The Diner'],
    'ordering is by the blended total with members breaking ties, as on REST');
});

test('revalidateSession refuses a token that names a different account', async () => {
  const jwt = require('jsonwebtoken');
  const { revalidateSession } = require('../sockets/handlers');

  calls = [];
  routes = [[/FROM users WHERE id = \$1/, [{ id: 50, is_banned: false, token_version: 0 }]]];

  const s = fakeSocket('drifted', { id: 50, name: 'Ava' });
  // A valid, unexpired, correctly-signed token — for somebody else.
  s.handshake = { auth: { token: jwt.sign({ userId: 51, tv: 0 }, process.env.JWT_SECRET) } };

  assert.strictEqual(await revalidateSession(s), 'session_revoked',
    'the token is re-verified and the ROW is read by socket.user.id; those two identities must agree');
  assert.strictEqual(s.disconnected, true);
  assert.strictEqual(calls.length, 0, 'and it refuses before spending a query on the wrong row');
});

test('a real friend request still rings over the socket, budget untouched', async () => {
  const { io, socket } = connect({ id: 1, name: 'Ava' });
  routes = [
    [/FROM user_blocks/, []],
    [/FROM friendships/, [{ '?column?': 1 }]],
  ];

  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    await fire(socket, 'friend_request_sent', { toUserId: 500 + i });
  }

  const rings = io.emitted.filter((e) => e.event === 'friend_request_received');
  assert.strictEqual(rings.length, 5, 'five different people, five deliveries');
  assert.deepStrictEqual(rings.map((r) => r.room), [500, 501, 502, 503, 504].map((id) => `user:${id}`));
});
