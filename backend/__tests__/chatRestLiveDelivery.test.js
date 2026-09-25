// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE REST SEND ROUTES ARE A TRANSPORT, NOT AN ARCHIVE
// ─────────────────────────────────────────────────────────────────────────────
//
// POST /api/flocks/:id/messages and POST /api/dm/:userId are what the socket
// client falls back to when ITS connection is down. Both persisted the row and
// then called pushIfOfflineDebounced, and that was the whole of their delivery.
//
// pushIfOfflineDebounced, by its name and by its job, notifies people who are
// OFFLINE. The sender being on a bad network says nothing about the recipient's
// connection: somebody sitting in the thread with a healthy socket is not
// offline, so they got no push, and no `new_dm` or `new_message` was ever
// emitted either. The message did not arrive. Not late, not out of order:
// not at all, until that person left the screen and came back, or their
// reconnect catch-up happened to fire.
//
// One person on a weak signal and the room went quiet for everyone else, which
// is the failure mode a fallback transport exists to prevent.
//
// These tests pin the delivery, the room it goes to, and the block filter that
// rides with it. They also pin the two smaller parity gaps found alongside it:
// the DM route did not invalidate the relationship cache the way its socket
// twin does (so typing dots on a brand new conversation sat out the 30s TTL),
// and it shipped no `reply_to` on the row it emits (so a reply delivered this
// way quoted a blank line under a blank name).
//
// No database and no real Socket.io. pool.query is a fixture dispatcher and
// `io` is a recorder.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'rest-live-delivery-test-secret';

const pool = require('../config/database');

let handlers = [];
async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = await fn(params || [], flat);
      return out === undefined ? { rows: [], rowCount: 0 } : out;
    }
  }
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}
pool.query = (sql, params) => dispatch(sql, params);
function on(re, fn) { handlers.push([re, fn]); }

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
let pushes = [];
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushIfOfflineDebounced = async (_io, userId) => { pushes.push(userId); return { skipped: true }; };

const moderationMod = require('../utils/moderation');
moderationMod.moderateImage = async () => ({ allowed: true });

const relationships = require('../utils/relationships');

const messagesRouter = require('../routes/messages');

// A recorder in the shape Socket.io presents to a route: io.to(room).emit(...).
let emits = [];
const io = { to: (room) => ({ emit: (event, payload) => { emits.push({ room, event, payload }); } }) };

const app = express();
app.use(express.json({ limit: '8mb' }));
app.set('io', io);
app.use('/api', messagesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  emits = [];
  pushes = [];
  CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
  relationships.__test.relationshipCache.clear();
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

// The response is sent before the delivery block runs, so a test that asserts
// on `emits` immediately after the fetch resolves is racing it. One tick of the
// event loop is enough for work that awaits only fixtures.
const settle = () => new Promise((r) => setTimeout(r, 20));

// ═════════════════════════════════════════════════════════════════════════════
// Flock chat
// ═════════════════════════════════════════════════════════════════════════════

function scriptFlockSend({ members = [2, 3], blocked = [] } = {}) {
  on(/SELECT id FROM flock_members WHERE flock_id/, () => ({ rows: [{ id: 10 }], rowCount: 1 }));
  on(/INSERT INTO messages/, (p) => ({
    rows: [{ id: 500, flock_id: p[0], sender_id: p[1], message_text: p[2], message_type: p[3] }],
    rowCount: 1,
  }));
  on(/SELECT name FROM flocks WHERE id/, () => ({ rows: [{ name: 'Friday' }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id/, () => ({
    rows: members.map((id) => ({ user_id: id })), rowCount: members.length,
  }));
  on(/blocked_id AS id FROM user_blocks|SELECT .* FROM user_blocks/, () => ({
    rows: blocked.map((id) => ({ id })), rowCount: blocked.length,
  }));
}

test('a flock message sent over REST is delivered live, not only pushed', async () => {
  scriptFlockSend();
  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'running late' });
  assert.strictEqual(res.status, 201, res.text);
  await settle();

  // The sender's own room gets a copy too now (the test further down says
  // why), so the members are read without it.
  const delivered = emits.filter((e) => e.event === 'new_message' && e.room !== 'user:1');
  assert.deepStrictEqual(
    delivered.map((e) => e.room).sort(),
    ['user:2', 'user:3'],
    'every other member gets the message on their personal room'
  );
  assert.strictEqual(delivered[0].payload.id, 500);
  assert.strictEqual(delivered[0].payload.sender_name, 'Ava');
});

test('live delivery goes to the personal room, never the flock room', async () => {
  // sockets/handlers.js fans out per member rather than broadcasting to
  // `flock:{id}`, for two reasons: a room broadcast cannot honour a mutual
  // block, and a member who has not OPENED this chat has never joined that
  // room and would receive nothing. Both reasons apply here identically.
  scriptFlockSend();
  await call('POST', '/api/flocks/7/messages', { message_text: 'hi' });
  await settle();
  assert.ok(emits.every((e) => !e.room.startsWith('flock:')), 'no room broadcast');
});

test('a blocked member is not delivered to, and is not pushed either', async () => {
  scriptFlockSend({ members: [2, 3], blocked: [3] });
  await call('POST', '/api/flocks/7/messages', { message_text: 'hi' });
  await settle();
  assert.deepStrictEqual(
    emits.filter((e) => e.event === 'new_message' && e.room !== 'user:1').map((e) => e.room),
    ['user:2']
  );
  assert.deepStrictEqual(pushes, [2]);
});

test("the sender's OTHER devices get their own REST send, once, as the sender's copy", async () => {
  // This used to pin the opposite: "the HTTP response IS the sender's
  // acknowledgement, and an echo would be a second copy". The response reaches
  // the device that posted and nothing else, and that device posted over REST
  // because its socket was down, so the account's other phones and tabs were
  // told nothing at all. The socket twin echoes to the sender's user room for
  // the same reason, and so does the DM route. The posting device tells the
  // copy apart from its own bubble by the client id it sent.
  scriptFlockSend({ members: [2] });
  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'hi', client_id: 'c-abc123' });
  assert.strictEqual(res.status, 201, res.text);
  await settle();
  const own = emits.filter((e) => e.event === 'new_message' && e.room === 'user:1');
  assert.strictEqual(own.length, 1, 'exactly one copy to the whole sending account');
  assert.strictEqual(own[0].payload.id, 500, 'the same row, so a device can dedupe on id');
  assert.strictEqual(own[0].payload.status, 'sent', "the sender's copy is the one with the receipt");
  assert.strictEqual(own[0].payload.client_id, 'c-abc123');
  assert.strictEqual(res.body.message.client_id, 'c-abc123', 'the HTTP answer carries it too');
  // And nobody else is handed the sender's own token.
  const toMember = emits.find((e) => e.event === 'new_message' && e.room === 'user:2');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(toMember.payload, 'client_id'), false);
  assert.strictEqual(toMember.payload.status, undefined);
});

test('a client id that is not a short safe token is dropped, never echoed and never a refusal', async () => {
  // Validated server side and trusted for nothing but echo matching: a value
  // that fails the shape costs the sender their exact match, not the message.
  for (const bad of ['has spaces', 'x'.repeat(65), '<script>', { id: 1 }, ['a'], 12]) {
    handlers = [];
    emits = [];
    scriptFlockSend({ members: [2] });
    // eslint-disable-next-line no-await-in-loop
    const res = await call('POST', '/api/flocks/7/messages', { message_text: 'hi', client_id: bad });
    assert.strictEqual(res.status, 201, `${JSON.stringify(bad)}: ${res.text}`);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.message, 'client_id'), false,
      `${JSON.stringify(bad)} was echoed`);
    // eslint-disable-next-line no-await-in-loop
    await settle();
    assert.ok(emits.every((e) => !Object.prototype.hasOwnProperty.call(e.payload, 'client_id')));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Flock replies: a quote has its own audience
// ═════════════════════════════════════════════════════════════════════════════
//
// A quote is a second path to the quoted person's words. The fan-out above is
// filtered by the SENDER's invisible set, which says nothing about the person
// being quoted: Ava (1) replying to Bo (9) went to member 3 with Bo's sentence
// inside it even when member 3 had blocked Bo. The socket twin cuts the quote
// out for exactly those members (__tests__/flockMessageReplies.test.js) and the
// history read drops it per viewer, so this transport was the one place the
// block failed, and only live.

const QUOTED = 9;
// sender_banned is read in the same statement as the rest of the quote (a
// banned author's words reach nobody live; see the test for it below). Bo is
// not banned, so the fixture answers false, which is what Postgres answers for
// `u.is_banned IS TRUE` on an ordinary account.
const QUOTE = { id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED, sender_name: 'Bo', sender_banned: false };
let blockAsks = [];

/**
 * @param invisibleTo  userId -> the ids getInvisibleUserIds answers for them.
 *                     Keyed on $1, because a reply asks twice: about the
 *                     sender (who receives at all) and about the quoted
 *                     author (who sees the quote).
 * @param failFor      a userId whose invisible set cannot be read.
 */
function scriptFlockReply({ members = [2, 3], quote = QUOTE, invisibleTo = {}, failFor = null } = {}) {
  blockAsks = [];
  // The scope check: the quoted message is in this flock and still readable.
  on(/^SELECT id FROM messages WHERE id = \$1 AND flock_id = \$2/, (p) => ({ rows: [{ id: p[0] }], rowCount: 1 }));
  on(/SELECT id FROM flock_members WHERE flock_id/, () => ({ rows: [{ id: 10 }], rowCount: 1 }));
  on(/INSERT INTO messages/, (p) => ({
    rows: [{ id: 500, flock_id: p[0], sender_id: p[1], message_text: p[2], message_type: p[3], reply_to_id: p[7] }],
    rowCount: 1,
  }));
  // The display hydrate, which now also reads whose words these are and
  // whether that account is banned. Matched on its opening columns and its
  // table rather than character for character.
  on(/^SELECT m\.id, m\.message_text, m\.message_type, m\.sender_id, u\.name AS sender_name\b[\s\S]* FROM messages m /, () => ({
    rows: [quote], rowCount: 1,
  }));
  on(/SELECT name FROM flocks WHERE id/, () => ({ rows: [{ name: 'Friday' }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id/, () => ({
    rows: members.map((id) => ({ user_id: id })), rowCount: members.length,
  }));
  on(/blocked_id AS id FROM user_blocks/, (p) => {
    const who = Number(p[0]);
    blockAsks.push(who);
    if (who === failFor) throw new Error('user_blocks unreadable');
    const ids = invisibleTo[who] || [];
    return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
  });
}

const flockCopy = (userId) => emits.find((e) => e.event === 'new_message' && e.room === `user:${userId}`);

test('a member who blocked the quoted author gets the REST reply WITHOUT the quote', async () => {
  // Ava has blocked nobody, so both members receive. Member 3 and Bo are
  // mutually invisible, which is what getInvisibleUserIds(Bo) answers.
  scriptFlockReply({ invisibleTo: { 1: [], [QUOTED]: [3] } });
  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'yes', reply_to_id: 400 });
  assert.strictEqual(res.status, 201, res.text);
  await settle();

  const toTwo = flockCopy(2);
  const toThree = flockCopy(3);
  assert.ok(toTwo && toThree, 'both members still receive the reply itself');
  assert.deepStrictEqual(toTwo.payload.reply_to, {
    id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED, sender_name: 'Bo',
  }, 'a member with no block sees the quote, in the five fields the socket twin ships');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(toThree.payload, 'reply_to'), false,
    "the blocker must not receive the blocked author's sentence, even quoted");
  assert.strictEqual(toThree.payload.message_text, 'yes', 'only the quote is withheld, never the reply');
  assert.strictEqual(toThree.payload.reply_to_id, 400, 'which the client draws as an ordinary message');
  assert.strictEqual(toThree.payload.id, toTwo.payload.id, 'the same row, so the client can dedupe on id');

  // The sender chose the quote and keeps it, exactly as the socket echo does.
  assert.deepStrictEqual(res.body.message.reply_to, toTwo.payload.reply_to);
  // The author's id rides, so a client that blocks them later can take this
  // quote down even when the quoted message was never loaded there. The ban
  // flag read beside it for the fan-out does not.
  assert.strictEqual(res.body.message.reply_to.sender_id, QUOTED);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.message.reply_to, 'sender_banned'), false,
    'the ban flag is read for the fan-out and never shipped');
});

test('the quote question is asked once, about the quoted author, not per member', async () => {
  scriptFlockReply({ members: [2, 3, 4, 5], invisibleTo: { 1: [], [QUOTED]: [3] } });
  await call('POST', '/api/flocks/7/messages', { message_text: 'yes', reply_to_id: 400 });
  await settle();
  // One question about the sender (who receives) and one about the quoted
  // author (who sees the quote). Compared as a set: the order is not
  // something any recipient can observe.
  assert.deepStrictEqual(blockAsks.slice().sort((a, b) => a - b), [1, QUOTED]);
});

test('an ordinary REST send asks no quote question at all', async () => {
  scriptFlockReply({ invisibleTo: { 1: [] } });
  await call('POST', '/api/flocks/7/messages', { message_text: 'no reply here' });
  await settle();
  assert.deepStrictEqual(blockAsks, [1], 'only the sender-side block read');
  assert.ok(emits.filter((e) => e.event === 'new_message').every((e) => e.payload.reply_to === undefined));
});

test('a quote whose author was deleted asks nothing more and still rides', async () => {
  // messages.sender_id is ON DELETE SET NULL, so a departed member's message
  // is still quotable, with no name and nobody to ask about.
  scriptFlockReply({ quote: { ...QUOTE, sender_id: null, sender_name: null }, invisibleTo: { 1: [] } });
  await call('POST', '/api/flocks/7/messages', { message_text: 'yes', reply_to_id: 400 });
  await settle();
  assert.deepStrictEqual(blockAsks, [1]);
  assert.ok(flockCopy(2).payload.reply_to && flockCopy(3).payload.reply_to);
});

test('a reply quoting a BANNED member reaches every member with the quote cut out', async () => {
  // The history read drops this quote for every viewer, because every
  // viewer's invisible set carries every banned account. The live copies asked
  // only the quoted author's OWN set, which names the people they have a block
  // with and nobody else, so the banned member's sentence went to the whole
  // room live and vanished on reload. Nobody here has a block with Bo; the ban
  // alone has to withhold it.
  scriptFlockReply({
    members: [2, 3],
    quote: { ...QUOTE, sender_banned: true },
    invisibleTo: { 1: [], [QUOTED]: [] },
  });
  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'yes', reply_to_id: 400 });
  assert.strictEqual(res.status, 201, res.text);
  await settle();

  for (const member of [2, 3]) {
    const copy = flockCopy(member);
    assert.ok(copy, `member ${member} still receives the reply itself`);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(copy.payload, 'reply_to'), false,
      `member ${member} received a banned member's words, quoted`);
    assert.strictEqual(copy.payload.message_text, 'yes', 'only the quote is withheld, never the reply');
    assert.strictEqual(copy.payload.reply_to_id, 400, 'which the client draws as an ordinary message');
  }
  // THE SENDER IS NOT EXEMPT. reply_to_id is a number the client sends, so a
  // member who knows a banned author's message id could reply to it and read
  // the words back out of their own answer, words the history read withholds
  // from them. Both of the sender's copies go through the same rule.
  assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.message, 'reply_to'), false,
    "the HTTP answer handed the sender a banned member's words");
  assert.strictEqual(res.body.message.reply_to_id, 400);
  const own = flockCopy(1);
  assert.ok(own, "the sender's other devices still get the reply");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(own.payload, 'reply_to'), false);
  // The ban answers the whole question, so the quoted author's block list is
  // not read at all; the only block read is the sender's.
  assert.deepStrictEqual(blockAsks, [1]);
});

test("a sender on the other side of a block from the quoted author gets their reply without the quote", async () => {
  // Either direction: the quoted author (9) and the sender (1) are mutually
  // invisible, which is what getInvisibleUserIds(9) answers. A member with no
  // block keeps the quote, so the rule is per person, not per message.
  scriptFlockReply({ members: [2], invisibleTo: { 1: [QUOTED], [QUOTED]: [1] } });
  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'yes', reply_to_id: 400 });
  assert.strictEqual(res.status, 201, res.text);
  await settle();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.message, 'reply_to'), false,
    'the sender read the words of somebody they are blocked with, through their own reply');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(flockCopy(1).payload, 'reply_to'), false);
  assert.deepStrictEqual(flockCopy(2).payload.reply_to, {
    id: 400, message_text: 'pizza?', message_type: 'text', sender_id: QUOTED, sender_name: 'Bo',
  }, 'the member with no block still sees the quote');
});

test('when the quote question cannot be answered, nobody gets the quote live', async () => {
  // Fails closed, the same way the sender-side read does: the message is
  // stored and answered, and members read it from history, which drops the
  // quote per viewer. Delivering it blind would be the leak this closes.
  scriptFlockReply({ invisibleTo: { 1: [] }, failFor: QUOTED });
  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'yes', reply_to_id: 400 });
  assert.strictEqual(res.status, 201, res.text);
  // The sender too: the question is asked before the answer now, and when it
  // cannot be answered the answer carries no quote.
  assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.message, 'reply_to'), false);
  assert.strictEqual(res.body.message.reply_to_id, 400, 'the reply itself is stored and answered');
  await settle();
  assert.deepStrictEqual(emits.filter((e) => e.event === 'new_message'), []);
  assert.deepStrictEqual(pushes, [], 'and no push goes out ahead of an answer either');
});

test("an account that left the plan while its send was screened gets no copy on its other devices", async () => {
  // The membership check at the top runs before the image screen, which can
  // take seconds. Asked again beside the roster: the second answer is "gone".
  scriptFlockSend({ members: [2] });
  let asked = 0;
  handlers = handlers.filter(([re]) => !re.test('SELECT id FROM flock_members WHERE flock_id = $1'));
  on(/SELECT id FROM flock_members WHERE flock_id/, () => {
    asked += 1;
    return asked === 1 ? { rows: [{ id: 10 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  });
  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'hi' });
  assert.strictEqual(res.status, 201, res.text);
  await settle();
  assert.strictEqual(asked, 2, 'the membership is asked again before the account echo');
  assert.ok(!emits.some((e) => e.event === 'new_message' && e.room === 'user:1'),
    "the departed account's other devices were handed a row from a plan it left");
  assert.ok(emits.some((e) => e.event === 'new_message' && e.room === 'user:2'),
    'the members still get the message, which is stored and in their history');
});

// ═════════════════════════════════════════════════════════════════════════════
// DMs
// ═════════════════════════════════════════════════════════════════════════════

function scriptDmSend({ replyRow = null } = {}) {
  on(/SELECT 1 FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/FROM friendships/, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
  on(/SELECT id FROM direct_messages WHERE id = \$1/, () => ({ rows: [{ id: 5 }], rowCount: 1 }));
  on(/SELECT dm\.id, dm\.message_text, dm\.sender_id, u\.name AS sender_name/, () => (
    replyRow ? { rows: [replyRow], rowCount: 1 } : { rows: [], rowCount: 0 }
  ));
  on(/INSERT INTO direct_messages/, (p) => ({
    rows: [{ id: 900, sender_id: p[0], receiver_id: p[1], message_text: p[2], reply_to_id: p[6] }],
    rowCount: 1,
  }));
}

test('a DM sent over REST reaches the recipient live', async () => {
  scriptDmSend();
  const res = await call('POST', '/api/dm/2', { message_text: 'outside' });
  assert.strictEqual(res.status, 201, res.text);
  await settle();

  const delivered = emits.filter((e) => e.event === 'new_dm');
  // Two rooms: the recipient's, and the sender's own account, whose OTHER
  // devices are the ones that need telling when one of them posted over REST
  // because its socket was down (guest and DM audit, 2026-09-05).
  assert.strictEqual(delivered.length, 2);
  const toRecipient = delivered.find((e) => e.room === 'user:2');
  assert.ok(toRecipient, 'the recipient no longer hears the message');
  const toSender = delivered.find((e) => e.room !== 'user:2');
  assert.ok(toSender && /^user:\d+$/.test(toSender.room) && toSender.room !== 'user:2',
    "the sender's account must hear its own message");
  assert.strictEqual(toRecipient.payload.id, 900);
  assert.strictEqual(toRecipient.payload.sender_name, 'Ava');
  assert.deepStrictEqual(toRecipient.payload.reactions, []);
  assert.strictEqual(toSender.payload.id, 900, 'the same row, so the client can dedupe on id');
});

test("a DM's client id comes back on the sender's copies and never reaches the recipient", async () => {
  // Two DMs that look alike, in flight together, used to be matched to their
  // bubbles on content alone. The client id is the exact match, and it is the
  // sender's own token: the recipient has no bubble to match and no use for it.
  scriptDmSend();
  const res = await call('POST', '/api/dm/2', { message_text: 'outside', client_id: 'c_dm-9' });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.message.client_id, 'c_dm-9');
  await settle();
  const toRecipient = emits.find((e) => e.event === 'new_dm' && e.room === 'user:2');
  const toSender = emits.find((e) => e.event === 'new_dm' && e.room === 'user:1');
  assert.strictEqual(toSender.payload.client_id, 'c_dm-9');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(toRecipient.payload, 'client_id'), false);
});

test('a reply delivered over REST carries the row it quotes', async () => {
  scriptDmSend({ replyRow: { id: 5, message_text: 'where are you', sender_id: 2, sender_name: 'Ben' } });
  const res = await call('POST', '/api/dm/2', { message_text: 'outside', reply_to_id: 5 });
  await settle();
  const delivered = emits.find((e) => e.event === 'new_dm');
  // The quoted author's id rides, as on the flock quote: a client that learns
  // of a block takes that person's words out of a quote by it, including one
  // on a row that reached it live after the block.
  assert.deepStrictEqual(delivered.payload.reply_to, { id: 5, message_text: 'where are you', sender_id: 2, sender_name: 'Ben' });
  // One quote on every copy: the sender's other devices and the answer too.
  assert.deepStrictEqual(emits.find((e) => e.event === 'new_dm' && e.room === 'user:1').payload.reply_to, delivered.payload.reply_to);
  assert.deepStrictEqual(res.body.message.reply_to, delivered.payload.reply_to);
});

test('a failed quote lookup drops the quote, never the message', async () => {
  // Decoration on the payload. The row is stored and reply_to_id is on it
  // either way, so this must not be able to turn a saved DM into a 500.
  handlers = [];
  on(/SELECT 1 FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/FROM friendships/, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
  on(/SELECT id FROM direct_messages WHERE id = \$1/, () => ({ rows: [{ id: 5 }], rowCount: 1 }));
  on(/SELECT dm\.id, dm\.message_text, dm\.sender_id, u\.name AS sender_name/, () => { throw new Error('boom'); });
  on(/INSERT INTO direct_messages/, (p) => ({
    rows: [{ id: 900, sender_id: p[0], receiver_id: p[1], reply_to_id: p[6] }], rowCount: 1,
  }));

  const res = await call('POST', '/api/dm/2', { message_text: 'outside', reply_to_id: 5 });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.message.reply_to_id, 5);
  assert.strictEqual(res.body.message.reply_to, undefined);
});

test('the stored DM invalidates the relationship cache, as the socket twin does', async () => {
  // That row IS the relationship. Without this a first DM sent over the
  // fallback left a cached "not connected" standing for the rest of the 30s
  // TTL, so typing dots and live location stayed refused on a conversation
  // that had just started.
  const { relationshipCache } = relationships.__test;
  relationshipCache.set('1_2', { ts: Date.now(), connected: false });
  scriptDmSend();
  await call('POST', '/api/dm/2', { message_text: 'outside' });
  assert.ok(!relationshipCache.has('1_2'), 'the stale "no" is gone');
});
