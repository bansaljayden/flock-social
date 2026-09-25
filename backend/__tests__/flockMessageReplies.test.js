// Run: node --test  (from backend/)
//
// REPLYING TO A MESSAGE IN A FLOCK (migration 066).
//
// direct_messages has carried reply_to_id since the bootstrap schema and
// `messages` never had the column, so the one chat surface where several
// conversations are actually braided together was the one that could not
// quote a specific line. This file pins the column, both transports, and the
// three ways a quote can leak something it should not.
//
// THE LEAK THAT MATTERS MOST IS THE THIRD ONE. A quote is a SECOND PATH TO
// SOMEBODY'S WORDS: the history query drops a blocked member's own rows and
// the reactions loop drops their reactions, but a reply carries their
// sentence inside somebody else's message. On the REST path that is filtered
// per viewer. On the socket path it cannot be, because one payload object
// fans out to every member, so the quote is stripped for exactly the members
// who cannot see its author. Both halves are asserted below.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'flock-reply-secret';

const pool = require('../config/database');

// Destructured at module load by sockets/handlers.js, so replaced first.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const moderationMod = require('../utils/moderation');
moderationMod.moderateImage = async () => ({ allowed: true, reason: null });

const { registerHandlers, __resetRateLimiters } = require('../sockets/handlers');

// --- harness (same shape as chatTransportParity.test.js) -------------------

let calls = [];
let routes = [];

function dispatch(sql, params) {
  calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, rows] of routes) {
    if (re.test(sql)) {
      return Promise.resolve({ rows: typeof rows === 'function' ? rows(params || []) : rows });
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 120)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

test.after(() => { pool.end?.().catch(() => {}); });

function fakeSocket(id, user) {
  const handlers = new Map();
  const emitted = [];
  const rooms = new Set();
  const socket = {
    id, user, rooms,
    handshake: null,
    on(event, handler) { handlers.set(event, handler); },
    join(room) { rooms.add(room); },
    leave(room) { rooms.delete(room); },
    emit(event, payload) { emitted.push({ target: 'self', event, payload }); },
    to(room) {
      const op = {
        excepted: null,
        except(r) { op.excepted = [].concat(r); return op; },
        emit(event, payload) { emitted.push({ target: room, event, payload, excepted: op.excepted }); },
      };
      return op;
    },
    disconnect() { socket.disconnected = true; },
    handlers, emitted,
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

function connect(user = { id: 1, name: 'Ava' }) {
  __resetRateLimiters();
  calls = [];
  routes = [];
  const io = fakeIo();
  const socket = fakeSocket('s1', user);
  registerHandlers(io, socket);
  socket.emitted.length = 0;
  return { io, socket };
}

const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);
const wrote = (table) => calls.filter((c) => new RegExp(`INSERT INTO ${table}`, 'i').test(c.sql));
const errors = (socket) => socket.emitted.filter((e) => e.event === 'error').map((e) => e.payload.message);
const blockQueries = () => calls.filter((c) => /FROM user_blocks/.test(c.sql));

const QUOTED_SENDER = 9; // Bo, whose message gets quoted
const MEMBERS = [{ user_id: 2 }, { user_id: 3 }, { user_id: QUOTED_SENDER }];

/**
 * @param opts.replyRow   what the reply lookup returns ([] means "not there")
 * @param opts.blockedBy  map of userId -> ids invisible to them, for the two
 *                        separate getInvisibleUserIds calls this path can make
 */
function scriptFlockSend({ replyRow = null, blocks = {} } = {}) {
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 10 }]],
    // The reply lookup. Distinctive on its select list so it cannot be
    // confused with the insert or the roster read.
    [/m\.sender_id, u\.name AS sender_name/, replyRow ? [replyRow] : []],
    [/INSERT INTO messages/, (p) => [{
      id: 501, flock_id: p[0], sender_id: p[1], message_text: p[2],
      message_type: p[3], image_url: p[5], reply_to_id: p[7],
    }]],
    [/SELECT name FROM flocks WHERE id = \$1/, [{ name: 'Friday' }]],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/, MEMBERS],
    // getInvisibleUserIds, called for the SENDER (who receives at all) and,
    // when a quote names somebody, for the QUOTED sender (who sees the quote).
    // Keyed on $1 so one route can answer both.
    [/FROM user_blocks/, (p) => (blocks[p[0]] || []).map((id) => ({ id }))],
  ];
}

const flockEmits = (io) => io.emitted.filter((e) => e.event === 'new_message');
const emitTo = (io, userId) => flockEmits(io).find((e) => e.room === `user:${userId}`);

// ---------------------------------------------------------------------------
// 1. The column exists and carries the value
// ---------------------------------------------------------------------------

test('a reply stores reply_to_id on the flock message', async () => {
  const { socket } = connect();
  scriptFlockSend({ replyRow: { id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED_SENDER, sender_name: 'Bo', sender_banned: false } });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'yes', reply_to_id: 400 });

  const inserts = wrote('messages');
  assert.strictEqual(inserts.length, 1, `refused: ${errors(socket).join(' | ')}`);
  assert.strictEqual(inserts[0].params[7], 400, 'reply_to_id must reach the insert');
  assert.deepStrictEqual(errors(socket), []);
});

test('an ordinary message stores a null reply_to_id and asks nothing extra', async () => {
  const { socket } = connect();
  scriptFlockSend();

  await fire(socket, 'send_message', { flockId: 3, message_text: 'hello' });

  assert.strictEqual(wrote('messages')[0].params[7], null);
  // The reply lookup must not run, and the SECOND block query (the one that
  // asks who cannot see a quoted author) must not run either.
  assert.strictEqual(calls.filter((c) => /m\.sender_id, u\.name AS sender_name/.test(c.sql)).length, 0);
  assert.strictEqual(blockQueries().length, 1, 'only the sender-side block read');
});

// ---------------------------------------------------------------------------
// 2. Scope: a quote may only reach inside this flock
// ---------------------------------------------------------------------------

test('a reply to a message in ANOTHER flock is refused, and nothing is stored', async () => {
  const { socket } = connect();
  // The lookup carries `AND m.flock_id = $2`, so a foreign id returns nothing.
  scriptFlockSend({ replyRow: null });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'leaking?', reply_to_id: 99999 });

  assert.strictEqual(wrote('messages').length, 0, 'a cross-flock quote must never be stored');
  assert.deepStrictEqual(errors(socket), ['That message is no longer there to reply to.']);
});

test('the reply lookup is scoped by flock_id, not by id alone', async () => {
  const { socket } = connect();
  scriptFlockSend({ replyRow: { id: 400, message_text: 'x', message_type: 'text', sender_id: QUOTED_SENDER, sender_name: 'Bo', sender_banned: false } });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'ok', reply_to_id: 400 });

  const lookup = calls.find((c) => /m\.sender_id, u\.name AS sender_name/.test(c.sql));
  assert.ok(lookup, 'the lookup must happen');
  assert.match(lookup.sql, /m\.flock_id = \$2/, 'without this predicate any message id is readable');
  assert.deepStrictEqual(lookup.params, [400, 3]);
  assert.match(lookup.sql, /is_hidden IS NOT TRUE/, 'a moderated message must not be quotable');
  assert.match(lookup.sql, /sender_deleted_at IS NULL/, 'an unsent message must not be quotable');
});

test('a reply target that is not an id at all says so instead of vanishing', async () => {
  const { socket } = connect();
  scriptFlockSend();

  await fire(socket, 'send_message', { flockId: 3, message_text: 'hi', reply_to_id: 'not-a-number' });

  assert.strictEqual(wrote('messages').length, 0);
  assert.deepStrictEqual(errors(socket), ['That message is no longer there to reply to.'],
    'a silent drop is defect 4 in the transport-parity suite');
});

// ---------------------------------------------------------------------------
// 3. The quote's shape
// ---------------------------------------------------------------------------

test("the quote carries its display fields and its author's id, and never the ban flag", async () => {
  const { io, socket } = connect();
  scriptFlockSend({ replyRow: { id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED_SENDER, sender_name: 'Bo', sender_banned: false } });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'yes', reply_to_id: 400 });

  // The echo goes to the sender's whole account (user:1), not this socket
  // alone, so it is read off the io emits with the members' copies.
  const echo = emitTo(io, 1);
  assert.ok(echo, 'the sender gets their own echo');
  // The author's id is what lets a client that blocks them take this quote
  // down when the quoted message was never loaded there. sender_banned was
  // read for the fan-out and stays off.
  assert.deepStrictEqual(echo.payload.reply_to, {
    id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED_SENDER, sender_name: 'Bo',
  }, 'the five fields the history read and the REST twin ship');

  // And the same object reaches a member with no block relationship.
  assert.deepStrictEqual(emitTo(io, 2).payload.reply_to, echo.payload.reply_to);
});

test('message_type rides along so a reply to a photo is not a blank quote', async () => {
  const { io, socket } = connect();
  scriptFlockSend({ replyRow: { id: 401, message_text: '', message_type: 'image', sender_id: QUOTED_SENDER, sender_name: 'Bo', sender_banned: false } });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'nice', reply_to_id: 401 });

  const echo = emitTo(io, 1);
  assert.strictEqual(echo.payload.reply_to.message_type, 'image');
});

// ---------------------------------------------------------------------------
// 4. THE BLOCK LEAK. A quote must not carry a blocked author's words.
// ---------------------------------------------------------------------------

test('a member who blocked the quoted author gets the reply WITHOUT the quote', async () => {
  const { io, socket } = connect();
  scriptFlockSend({
    replyRow: { id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED_SENDER, sender_name: 'Bo', sender_banned: false },
    // Ava (the sender, id 1) has blocked nobody, so everyone receives.
    // Member 3 and Bo are mutually invisible, which is what
    // getInvisibleUserIds(Bo) returns.
    blocks: { 1: [], [QUOTED_SENDER]: [3] },
  });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'yes', reply_to_id: 400 });

  const toTwo = emitTo(io, 2);
  const toThree = emitTo(io, 3);
  assert.ok(toTwo && toThree, 'both members still receive the reply itself');

  assert.ok(toTwo.payload.reply_to, 'a member with no block sees the quote');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(toThree.payload, 'reply_to'), false,
    "the blocker must not receive the blocked author's sentence, even quoted"
  );
  assert.strictEqual(toThree.payload.message_text, 'yes',
    'the reply itself is still delivered: only the quote is withheld');
});

test('the "who cannot see the quoted author" question is asked once, not per member', async () => {
  const { socket } = connect();
  scriptFlockSend({
    replyRow: { id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED_SENDER, sender_name: 'Bo', sender_banned: false },
    blocks: { 1: [], [QUOTED_SENDER]: [3] },
  });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'yes', reply_to_id: 400 });

  // Exactly two, and exactly these two: once for the sender, deciding who
  // receives the message at all, and once for the quoted author, deciding who
  // sees the quote. Never once per member, which is what a naive fix looks
  // like and what would make a busy flock pay a query per recipient.
  //
  // Compared as a SET. Which of the two runs first is an implementation
  // detail that neither the sender nor the recipients can observe, and an
  // assertion on the order would fail the day somebody reorders two
  // independent reads without changing any behaviour.
  const asked = blockQueries().map((c) => c.params[0]).sort((a, b) => a - b);
  assert.deepStrictEqual(asked, [1, QUOTED_SENDER],
    `expected one question about the sender and one about the quoted author, got ${asked.join(',')}`);
});

test('a quote whose author was deleted asks no block question and still delivers', async () => {
  const { io, socket } = connect();
  // messages.sender_id is ON DELETE SET NULL, so a departed member's message
  // is still quotable and its sender_name is null.
  scriptFlockSend({
    replyRow: { id: 400, message_text: 'pizza?', message_type: 'text', sender_id: null, sender_name: null },
    blocks: { 1: [] },
  });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'yes', reply_to_id: 400 });

  assert.strictEqual(wrote('messages').length, 1, `refused: ${errors(socket).join(' | ')}`);
  assert.strictEqual(blockQueries().length, 1, 'nobody to ask about');
  assert.ok(emitTo(io, 2).payload.reply_to, 'the quote still rides');
});

test('a reply quoting a BANNED member reaches every member with the quote cut out', async () => {
  // The history read drops this quote for every viewer, because every
  // viewer's invisible set carries every banned account. The fan-out asked
  // only the quoted author's OWN set, which names the people they have a block
  // with, so a banned member's sentence went to the whole room live and
  // vanished on reload. Nobody here has a block with Bo; the ban alone decides.
  const { io, socket } = connect();
  scriptFlockSend({
    replyRow: { id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED_SENDER, sender_name: 'Bo', sender_banned: true },
    blocks: { 1: [], [QUOTED_SENDER]: [] },
  });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'yes', reply_to_id: 400 });

  assert.strictEqual(wrote('messages').length, 1, `refused: ${errors(socket).join(' | ')}`);
  for (const member of [2, 3]) {
    const copy = emitTo(io, member);
    assert.ok(copy, `member ${member} still receives the reply itself`);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(copy.payload, 'reply_to'), false,
      `member ${member} received a banned member's words, quoted`);
    assert.strictEqual(copy.payload.message_text, 'yes');
  }
  // THE SENDER IS NOT EXEMPT. reply_to_id is a number the client sends, and
  // the lookup above does not ask about bans, so a member who knew a banned
  // author's message id could reply to it and read the words back out of
  // their own echo. The history read withholds them from the sender too.
  const own = emitTo(io, 1);
  assert.ok(own, 'the sender still gets their echo');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(own.payload, 'reply_to'), false,
    "the sender's echo carried a banned member's words");
  // The ban answers the whole question: the quoted author's block list is not
  // read, only the sender's.
  assert.deepStrictEqual(blockQueries().map((c) => c.params[0]), [1]);
});

test("a sender with a block against the quoted author gets their echo without the quote", async () => {
  // Either direction reads the same: getInvisibleUserIds(Bo) names the sender.
  const { io, socket } = connect();
  scriptFlockSend({
    replyRow: { id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED_SENDER, sender_name: 'Bo', sender_banned: false },
    blocks: { 1: [QUOTED_SENDER], [QUOTED_SENDER]: [1] },
  });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'yes', reply_to_id: 400 });

  assert.strictEqual(wrote('messages').length, 1, `refused: ${errors(socket).join(' | ')}`);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(emitTo(io, 1).payload, 'reply_to'), false,
    'the sender read the words of somebody they are blocked with, through their own echo');
  assert.ok(emitTo(io, 2).payload.reply_to, 'a member with no block still sees the quote');
});

test("an account that left the plan while its send was screened is echoed on the sending socket only", async () => {
  // The membership check at the top runs before the image screen, which can
  // take seconds. It is asked again beside the quote question, just before the
  // echo, and here the second answer is "gone".
  const { io, socket } = connect();
  scriptFlockSend();
  let asked = 0;
  routes = routes.filter(([re]) => !re.test('FROM flock_members WHERE flock_id = $1 AND user_id = $2'));
  routes.unshift([/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => {
    asked += 1;
    return asked === 1 ? [{ id: 10 }] : [];
  }]);

  await fire(socket, 'send_message', { flockId: 3, message_text: 'yes' });

  assert.strictEqual(asked, 2, 'the membership is asked again before the echo');
  assert.strictEqual(emitTo(io, 1), undefined, "the departed account's other devices got the row");
  assert.ok(socket.emitted.some((e) => e.event === 'new_message' && e.payload.id === 501),
    'the socket that sent it, which already holds the bubble, still settles it');
  assert.ok(emitTo(io, 2), 'the members still get the message, which is stored');
});

test('the reply lookup reads the quoted author\'s ban in the same statement', async () => {
  const { socket } = connect();
  scriptFlockSend({ replyRow: { id: 400, message_text: 'x', message_type: 'text', sender_id: QUOTED_SENDER, sender_name: 'Bo', sender_banned: false } });

  await fire(socket, 'send_message', { flockId: 3, message_text: 'ok', reply_to_id: 400 });

  const lookup = calls.find((c) => /m\.sender_id, u\.name AS sender_name/.test(c.sql));
  assert.ok(lookup, 'the lookup must happen');
  assert.match(lookup.sql, /u\.is_banned IS TRUE AS sender_banned/,
    'without the column replyCopies withholds every quote, and with a looser read it would leak one');
});

test('a quote question that cannot be answered costs the live delivery, never the saved message', async () => {
  // replyCopies used to be asked outside the fan-out's try, so a failed block
  // read here answered "Failed to send message" about a row that was already
  // stored, and a client that retried it posted it twice. It is asked inside
  // the fan-out now, where the REST twin asks it.
  const { io, socket } = connect();
  scriptFlockSend({
    replyRow: { id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED_SENDER, sender_name: 'Bo', sender_banned: false },
  });
  routes = routes.filter(([re]) => !re.test('FROM user_blocks'));
  routes.push([/FROM user_blocks/, (p) => {
    if (Number(p[0]) === QUOTED_SENDER) throw new Error('user_blocks unreadable');
    return [];
  }]);

  await fire(socket, 'send_message', { flockId: 3, message_text: 'yes', reply_to_id: 400 });

  assert.strictEqual(wrote('messages').length, 1, 'the message is stored');
  assert.deepStrictEqual(flockEmits(io), [], 'nobody receives a copy whose quote could not be decided');
  assert.deepStrictEqual(errors(socket), ['Message saved, but live delivery is delayed.']);
  const own = socket.emitted.find((e) => e.event === 'new_message' && e.payload.id === 501);
  assert.ok(own, 'the sender keeps their own saved message');
  // Nobody includes the sender: a quote whose audience was never decided is
  // withheld from their echo too, as the history read would withhold it.
  assert.strictEqual(Object.prototype.hasOwnProperty.call(own.payload, 'reply_to'), false);
  assert.strictEqual(own.payload.reply_to_id, 400);
});

// ---------------------------------------------------------------------------
// 5. The REST twin, and the migration under both
// ---------------------------------------------------------------------------

const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messages.js'), 'utf8').replace(/\r\n/g, '\n');
const migrationSrc = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '066_flock_message_replies.sql'), 'utf8'
).replace(/\r\n/g, '\n');

test('the REST send scopes its reply target to the flock and refuses a bad one', () => {
  assert.match(routeSrc, /WHERE id = \$1 AND flock_id = \$2\s*\n\s*AND is_hidden IS NOT TRUE AND sender_deleted_at IS NULL/,
    'the REST scope check must carry all three predicates');
  assert.match(routeSrc, /Invalid reply target/, 'a bad target is a 400, not a silent null');
});

test('the REST history hydrate filters quotes by the viewer\'s own invisible set', () => {
  // The per-viewer half of the leak the socket test above covers per payload.
  assert.match(routeSrc, /if \(r\.sender_id != null && invisible\.has\(r\.sender_id\)\) continue;/,
    'without this a blocked member\'s words arrive quoted inside somebody else\'s reply');
  assert.match(routeSrc, /WHERE m\.id = ANY\(\$1\) AND m\.flock_id = \$2/,
    'the hydrate must be scoped to this flock');
  // And the reloaded quote is the live one's shape, author id included, so a
  // block can take it down on a client that never loaded the quoted message.
  assert.match(routeSrc, /replyMap\[r\.id\] = \{\s*id: r\.id,\s*message_text: r\.message_text,\s*message_type: r\.message_type,\s*sender_id: r\.sender_id,\s*sender_name: r\.sender_name,\s*\};/,
    'the history quote ships the same five fields as both send paths');
});

test('the migration adds the column with the DM twin\'s delete behaviour', () => {
  assert.match(migrationSrc, /ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages\(id\) ON DELETE SET NULL/,
    'ON DELETE CASCADE would let one deletion remove other people\'s messages');
  assert.match(migrationSrc, /^-- @noTransaction/, 'CONCURRENTLY needs autocommit');
  assert.match(migrationSrc, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_reply_to/);
  assert.match(migrationSrc, /NOT i\.indisvalid/, 'a failed CONCURRENTLY build must be cleaned up on retry');
});

test('the migration is Latin-1 clean, which the boot-safety test requires', () => {
  // 065 failed the whole boot over a box-drawing character: the embedded
  // Postgres runs WIN1252 and U+2500 has no encoding there.
  const offending = [...migrationSrc].filter((ch) => ch.charCodeAt(0) > 255);
  assert.deepStrictEqual(offending, [], `non-Latin-1 characters: ${offending.join(' ')}`);
});
