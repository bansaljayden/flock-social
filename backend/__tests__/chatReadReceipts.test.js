// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// A RECEIPT THAT LIES IS WORSE THAN NO RECEIPT
// ─────────────────────────────────────────────────────────────────────────────
//
// Migration 065 gave the chat its first record of whether a message reached a
// device and whether anybody looked. frontend/src/components/chat/StatusLine.js
// has been able to draw the whole ladder for some time and has been handed
// nothing but 'sending' and 'failed', because the server had no other word it
// could honestly say. Its own comment is the standard this suite holds the
// backend to: "NEVER A STATE THE SERVER CANNOT BACK."
//
// What is pinned here, in order:
//
//   1. THE LADDER. utils/messageStatus.js turns stored state into one of three
//      words and answers nothing for everything else. A receipt only ever
//      appears on the viewer's OWN message, because it is the sender's fact.
//   2. DELIVERED IS NOT OPENED. A message can sit on 'delivered' forever. The
//      history read marks delivery and must NEVER mark an open: a client pages
//      history on reconnect and on a background catch-up, and calling either
//      of those "Opened" is the lie the whole feature turns on.
//   3. A GROUP, PARTLY READ. Some members opened it and some did not, and the
//      names in "Opened by Sam and two others" are exactly the ones who did.
//   4. BLOCKS AND BANS. A blocked or banned member never appears in an
//      "Opened by" list and never receipts a DM in either direction.
//   5. THE MIGRATION SURVIVES A REPLAY. __tests__/migrationBootSafety.test.js
//      runs the real chain twice over live data; this asserts the property that
//      makes 065 able to pass it, in a form that names the mistake.
//
// No database and no real Socket.io: pool.query is a strict fixture dispatcher
// (an unscripted query throws rather than returning an empty result, so a query
// nobody modelled cannot pass silently) and `io` is a recorder.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'read-receipts-test-secret';

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
let CURRENT_USER = { id: 1, name: 'Ava Chen', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushBadgeSync = async () => ({ skipped: true });
// Delivery-on-send asks this and nothing else. Overridden per test.
// UNINSPECTABLE is the broadcaster shape pushHelper's real isUserOnline throws
// on (no `sockets.adapter` behind it): a partial stub, or a Socket.io whose
// internals moved. The wrapper in sockets/handlers.js has to answer "no"
// rather than let that become an exception, or a receipt.
const UNINSPECTABLE = Symbol('io with no adapter behind it');
let ONLINE = new Set();
pushMod.isUserOnline = (ioArg, userId) => {
  if (ioArg === UNINSPECTABLE) throw new TypeError("Cannot read properties of undefined (reading 'rooms')");
  return ONLINE.has(Number(userId));
};

const moderationMod = require('../utils/moderation');
moderationMod.moderateImage = async () => ({ allowed: true });

const relationships = require('../utils/relationships');

const messageStatus = require('../utils/messageStatus');
const socketHandlers = require('../sockets/handlers');
const messagesRouter = require('../routes/messages');

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
  ONLINE = new Set();
  CURRENT_USER = { id: 1, name: 'Ava Chen', email_verified: true, role: 'user' };
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

// Receipt work deliberately runs AFTER the response, so a test asserting on
// `emits` straight after the fetch resolves is racing it.
const settle = () => new Promise((r) => setTimeout(r, 25));

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE LADDER
// ═════════════════════════════════════════════════════════════════════════════

test('a DM that was delivered and not opened reads "delivered", and stays there', () => {
  const row = { id: 9, sender_id: 1, delivered_at: '2026-09-05T10:00:00Z', opened_at: null };
  assert.strictEqual(messageStatus.dmStatusFor(row, 1), 'delivered');
  // The point of the feature: nothing about the passage of time, a history
  // fetch or a push promotes this. Only an opened_at does.
  assert.strictEqual(messageStatus.dmStatusFor({ ...row, opened_at: '2026-09-05T10:05:00Z' }, 1), 'opened');
});

test('a stored DM with no receipt at all reads "sent", never "delivered"', () => {
  const row = { id: 9, sender_id: 1, delivered_at: null, opened_at: null };
  assert.strictEqual(messageStatus.dmStatusFor(row, 1), 'sent');
});

test('a receipt belongs to the sender: an incoming row carries no status', () => {
  const incoming = { id: 9, sender_id: 2, delivered_at: '2026-09-05T10:00:00Z', opened_at: '2026-09-05T10:01:00Z' };
  assert.strictEqual(messageStatus.dmStatusFor(incoming, 1), null);
  const rows = [incoming, { id: 10, sender_id: 1, delivered_at: null, opened_at: null }];
  messageStatus.attachDmStatus(rows, 1);
  assert.strictEqual(rows[0].status, undefined);
  assert.strictEqual(rows[1].status, 'sent');
});

test('only the five words StatusLine knows are ever produced', () => {
  // The server owns three of them. 'sending' and 'failed' are the client's own
  // knowledge of a send that never came back, and nothing here may claim them.
  assert.deepStrictEqual(messageStatus.SERVER_STATUSES, ['sent', 'delivered', 'opened']);
  for (const s of messageStatus.SERVER_STATUSES) {
    assert.ok(messageStatus.CLIENT_STATUSES.includes(s), `${s} is not a word StatusLine draws`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. A GROUP, PARTLY READ
// ═════════════════════════════════════════════════════════════════════════════

// Four members, deliberately at four different points on the ladder: two have
// read up to 100, one received everything and read almost none of it, and one
// has barely received anything. Every delivery watermark is at or above its own
// open watermark, which is the invariant the write paths keep.
const ROSTER = [
  { user_id: 2, name: 'Sam Okafor', last_delivered_message_id: 120, last_opened_message_id: 100 },
  { user_id: 3, name: 'Maya Lindqvist', last_delivered_message_id: 120, last_opened_message_id: 100 },
  { user_id: 4, name: 'Devon Price', last_delivered_message_id: 120, last_opened_message_id: 42 },
  { user_id: 5, name: 'Rae Nakamura', last_delivered_message_id: 20, last_opened_message_id: 0 },
];

test('opened by some of a group and not others: the names are exactly the openers', () => {
  const roster = messageStatus.flockRoster(ROSTER);
  const { status, openedBy } = messageStatus.flockStatusFor(90, roster);
  assert.strictEqual(status, 'opened');
  // Devon's watermark is 42 and Rae's is 0, so neither opened message 90.
  assert.deepStrictEqual(openedBy, ['Sam', 'Maya']);
  // "Opened by Sam and one other" is the count of this same array on the
  // client, so it can never disagree with the expanded list.
  assert.strictEqual(openedBy.length, 2);
});

test('delivered to a group but opened by nobody stops at "delivered"', () => {
  const roster = messageStatus.flockRoster(ROSTER.map((m) => ({ ...m, last_opened_message_id: 0 })));
  const { status, openedBy } = messageStatus.flockStatusFor(90, roster);
  assert.strictEqual(status, 'delivered');
  assert.deepStrictEqual(openedBy, []);
});

test('a group message nobody has received yet is "sent"', () => {
  const roster = messageStatus.flockRoster(ROSTER.map((m) => ({
    ...m, last_delivered_message_id: 0, last_opened_message_id: 0,
  })));
  assert.deepStrictEqual(messageStatus.flockStatusFor(90, roster), { status: 'sent', openedBy: [] });
});

test('the whole page is answered from one roster, with no query per message', () => {
  const roster = messageStatus.flockRoster(ROSTER);
  const rows = [];
  for (let id = 1; id <= 130; id += 1) rows.push({ id, sender_id: id % 2 === 0 ? 1 : 7 });
  messageStatus.attachFlockStatus(rows, 1, roster);
  // Message 2 is under three open watermarks and above Rae's, who has opened
  // nothing: a watermark of 0 reads as "opened nothing", never as "opened all".
  assert.strictEqual(rows.find((r) => r.id === 2).status, 'opened');
  assert.deepStrictEqual(rows.find((r) => r.id === 2).openedBy, ['Sam', 'Maya', 'Devon']);
  // 130 is above every watermark of either kind, so it is still only 'sent'.
  assert.strictEqual(rows.find((r) => r.id === 130).status, 'sent');
  // Somebody else's rows are untouched no matter what the roster says.
  assert.strictEqual(rows.find((r) => r.id === 3).status, undefined);
});

test('a watermark that arrives as a string still compares as a number', () => {
  // '20' >= 9 is false as a string comparison and true as a number. A fake, a
  // JSON round trip or a COALESCE through NUMERIC can all produce the string.
  const roster = messageStatus.flockRoster([
    { user_id: 2, name: 'Sam', last_delivered_message_id: '20', last_opened_message_id: '20' },
  ]);
  assert.strictEqual(messageStatus.flockStatusFor(9, roster).status, 'opened');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE FLOCK HISTORY READ
// ═════════════════════════════════════════════════════════════════════════════

function scriptFlockHistory({ rows, roster, invisible = [], members = [2, 3, 4, 5] }) {
  on(/^SELECT id FROM flock_members WHERE flock_id/, () => ({ rows: [{ id: 10 }], rowCount: 1 }));
  on(/blocked_id AS id FROM user_blocks/, () => ({
    rows: invisible.map((id) => ({ id })), rowCount: invisible.length,
  }));
  on(/FROM messages m LEFT JOIN users u/, () => ({ rows: rows.slice().reverse(), rowCount: rows.length }));
  on(/FROM emoji_reactions er/, () => ({ rows: [], rowCount: 0 }));
  on(/FROM flock_members fm JOIN users u/, (p) => {
    // The route hands its invisible set to the query; the fixture honours it
    // the way Postgres would, so this test proves the FILTER and not just that
    // a parameter was passed.
    const hidden = new Set((p[2] || []).map(Number));
    const visible = roster.filter((m) => !hidden.has(Number(m.user_id)));
    return { rows: visible, rowCount: visible.length };
  });
  on(/^UPDATE flock_members SET last_delivered_message_id/, () => ({ rows: [], rowCount: 0 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id/, () => ({
    rows: members.map((id) => ({ user_id: id })), rowCount: members.length,
  }));
}

test('a flock history read carries the roster and a receipt on the viewer\'s own rows', async () => {
  scriptFlockHistory({
    rows: [
      { id: 88, flock_id: 7, sender_id: 1, message_text: 'we still on?' },
      { id: 90, flock_id: 7, sender_id: 7, message_text: 'yep' },
      { id: 105, flock_id: 7, sender_id: 1, message_text: 'cool' },
    ],
    roster: ROSTER,
  });
  const res = await call('GET', '/api/flocks/7/messages');
  assert.strictEqual(res.status, 200, res.text);

  assert.ok(Array.isArray(res.body.readers), 'the roster rides with the page');
  assert.deepStrictEqual(res.body.readers.map((r) => r.userId), [2, 3, 4, 5]);

  const byId = Object.fromEntries(res.body.messages.map((m) => [m.id, m]));
  // 88 is under Sam's and Maya's watermarks (100) and over Devon's (42).
  assert.strictEqual(byId[88].status, 'opened');
  assert.deepStrictEqual(byId[88].openedBy, ['Sam', 'Maya']);
  // 105 is over every open watermark but under three delivery watermarks:
  // three phones have it and nobody has looked. This is the state the whole
  // feature turns on, and nothing may promote it on its own.
  assert.strictEqual(byId[105].status, 'delivered');
  assert.strictEqual(byId[105].openedBy, undefined);
  // Somebody else's message never carries a receipt.
  assert.strictEqual(byId[90].status, undefined);
});

test('a blocked member is excluded from the "Opened by" list', async () => {
  scriptFlockHistory({
    rows: [{ id: 88, flock_id: 7, sender_id: 1, message_text: 'we still on?' }],
    roster: ROSTER,
    invisible: [3], // Maya blocked the viewer, or was banned. Same set either way.
  });
  const res = await call('GET', '/api/flocks/7/messages');
  assert.strictEqual(res.status, 200, res.text);

  assert.deepStrictEqual(res.body.readers.map((r) => r.userId), [2, 4, 5],
    'a blocked or banned member is not in the roster at all');
  const msg = res.body.messages[0];
  assert.strictEqual(msg.status, 'opened');
  assert.deepStrictEqual(msg.openedBy, ['Sam'],
    'Maya opened it and must not be named: an "Opened by" list is a list of people');
});

test('a history read marks DELIVERY and never marks an open', async () => {
  const writes = [];
  scriptFlockHistory({
    rows: [{ id: 95, flock_id: 7, sender_id: 7, message_text: 'yep' }],
    roster: ROSTER,
  });
  // Re-register ahead of the fixture above so this one wins.
  handlers.unshift([/^UPDATE flock_members SET last_delivered/, (p, sql) => {
    writes.push({ sql, p });
    return { rows: [{ last_delivered_message_id: 95, last_opened_message_id: 0 }], rowCount: 1 };
  }]);
  const res = await call('GET', '/api/flocks/7/messages');
  assert.strictEqual(res.status, 200, res.text);
  await settle();

  assert.strictEqual(writes.length, 1, 'the viewer\'s delivery watermark moves');
  assert.match(writes[0].sql, /last_delivered_message_id = \$3/);
  assert.ok(!/last_opened_message_id\s*=/.test(writes[0].sql),
    'a history fetch is a background catch-up, not a person reading');
  assert.deepStrictEqual(writes[0].p, [7, 1, 95]);

  const read = emits.filter((e) => e.event === 'flock_read');
  assert.ok(read.length > 0, 'the other members hear that this person received it');
  assert.strictEqual(read[0].payload.lastOpenedMessageId, 0);
});

test('an older cursor page writes no receipt at all', async () => {
  scriptFlockHistory({
    rows: [{ id: 12, flock_id: 7, sender_id: 7, message_text: 'old' }],
    roster: ROSTER,
  });
  handlers.unshift([/^UPDATE flock_members SET last_delivered/, () => {
    throw new Error('a cursor page must not write a delivery watermark');
  }]);
  const res = await call('GET', '/api/flocks/7/messages?before=50');
  assert.strictEqual(res.status, 200, res.text);
  await settle();
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. OPENING IS ITS OWN DOOR
// ═════════════════════════════════════════════════════════════════════════════

test('PUT /flocks/:id/opened sets the open watermark and the delivery one with it', async () => {
  let updateSql = null;
  on(/^UPDATE flock_members SET last_opened_message_id/, (p, sql) => {
    updateSql = sql;
    assert.deepStrictEqual(p, [7, 1, 95]);
    return { rows: [{ last_delivered_message_id: 95, last_opened_message_id: 95 }], rowCount: 1 };
  });
  on(/SELECT user_id FROM flock_members WHERE flock_id/, () => ({ rows: [{ user_id: 2 }], rowCount: 1 }));
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));

  const res = await call('PUT', '/api/flocks/7/opened', { lastMessageId: 95 });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.lastOpenedMessageId, 95);
  // Opening a thread from a push never ran a history read, so the open half
  // has to carry the delivery half or the ladder skips a rung.
  assert.match(updateSql, /last_delivered_message_id = GREATEST/);
  assert.match(updateSql, /GREATEST\(last_opened_message_id, \$3\)/);

  const read = emits.filter((e) => e.event === 'flock_read');
  assert.strictEqual(read.length, 1);
  assert.strictEqual(read[0].room, 'user:2');
  assert.strictEqual(read[0].payload.lastOpenedMessageId, 95);
  assert.strictEqual(read[0].payload.name, 'Ava Chen');
});

test('a non-member opening a flock gets 404 and moves nothing', async () => {
  on(/^UPDATE flock_members SET last_opened_message_id/, () => ({ rows: [], rowCount: 0 }));
  const res = await call('PUT', '/api/flocks/7/opened', { lastMessageId: 95 });
  assert.strictEqual(res.status, 404, res.text);
  assert.strictEqual(emits.length, 0);
});

test('the open route rejects a missing or unusable watermark', async () => {
  for (const body of [{}, { lastMessageId: 0 }, { lastMessageId: 'soon' }, { lastMessageId: 2147483648 }]) {
    const res = await call('PUT', '/api/flocks/7/opened', body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
  }
});

test('the open watermark is a different column from the unread cursor of 056', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messages.js'), 'utf8');
  // PUT /flocks/:id/read writes the badge cursor; PUT /flocks/:id/opened writes
  // the receipt. If one route ever writes the other's column, every receipt in
  // the product becomes a claim the client made about its own unread dot.
  assert.ok(/last_read_message_id = GREATEST/.test(src), 'the 056 cursor route is still here');
  assert.ok(!/last_read_message_id[^\n]*last_opened_message_id/.test(src),
    'the badge cursor and the open receipt must never be written together');
  const handlersSrc = fs.readFileSync(path.join(__dirname, '..', 'sockets', 'handlers.js'), 'utf8');
  assert.ok(!/last_read_message_id/.test(handlersSrc),
    'nothing in the receipt path may read or write the client-owned badge cursor');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. DMs
// ═════════════════════════════════════════════════════════════════════════════

function scriptDmThread({ rows, bannedCounterparts = [] }) {
  on(/FROM user_blocks WHERE \(blocker_id = \$1 AND blocked_id = \$2\)/, () => ({ rows: [], rowCount: 0 }));
  // The thread read's ban gate. It asks about the ONE person in the URL — one
  // row for one id — rather than reading back every banned account in the
  // product to scan for that id, so the fixture answers per id. Anchored to the
  // whole statement, because a loose `FROM users` would also catch reads that
  // have nothing to do with bans and hand them a ban verdict.
  on(/^SELECT 1 FROM users WHERE id = \$1 AND is_banned IS TRUE$/, (p) => (
    bannedCounterparts.map(Number).includes(Number(p[0]))
      ? { rows: [{ '?column?': 1 }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  ));
  on(/FROM direct_messages dm JOIN users u/, () => ({ rows: rows.slice().reverse(), rowCount: rows.length }));
  on(/FROM dm_emoji_reactions dr/, () => ({ rows: [], rowCount: 0 }));
  on(/^UPDATE direct_messages SET read_status = TRUE/, () => ({ rows: [], rowCount: 0 }));
}

test('a DM thread read carries the ladder on the viewer\'s own rows only', async () => {
  scriptDmThread({
    rows: [
      { id: 40, sender_id: 1, receiver_id: 2, message_text: 'hey', delivered_at: '2026-09-05T10:00:00Z', opened_at: null },
      { id: 41, sender_id: 2, receiver_id: 1, message_text: 'hi', delivered_at: null, opened_at: null },
      { id: 42, sender_id: 1, receiver_id: 2, message_text: 'still there?', delivered_at: null, opened_at: null },
    ],
  });
  on(/^UPDATE direct_messages SET delivered_at = NOW\(\)/, () => ({ rows: [], rowCount: 0 }));

  const res = await call('GET', '/api/dm/2');
  assert.strictEqual(res.status, 200, res.text);
  const byId = Object.fromEntries(res.body.messages.map((m) => [m.id, m]));
  assert.strictEqual(byId[40].status, 'delivered');
  assert.strictEqual(byId[42].status, 'sent');
  assert.strictEqual(byId[41].status, undefined, 'their message is not our receipt');
});

test('reading a DM thread marks delivery, tells the sender, and marks no open', async () => {
  let deliverSql = null;
  scriptDmThread({
    rows: [{ id: 41, sender_id: 2, receiver_id: 1, message_text: 'hi', delivered_at: null, opened_at: null }],
  });
  on(/^UPDATE direct_messages SET delivered_at = NOW\(\)/, (p, sql) => {
    deliverSql = sql;
    assert.deepStrictEqual(p, [1, 2, null], 'everything from this person, nothing from anyone else');
    return { rows: [{ id: 41 }], rowCount: 1 };
  });
  on(/^UPDATE direct_messages SET opened_at/, () => {
    throw new Error('a history read must never set opened_at');
  });

  const res = await call('GET', '/api/dm/2');
  assert.strictEqual(res.status, 200, res.text);
  await settle();

  assert.match(deliverSql, /delivered_at IS NULL/, 'idempotent: a second read writes nothing');
  assert.match(deliverSql, /COALESCE\(is_hidden, false\) = false AND sender_deleted_at IS NULL/,
    'a taken-down or unsent message is gone from every read path and must not receipt either');

  const delivered = emits.filter((e) => e.event === 'dm_delivered');
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].room, 'user:2', 'the receipt goes to the sender and nowhere else');
  assert.deepStrictEqual(delivered[0].payload, { withUserId: 1, messageIds: [41] });
});

test('PUT /dm/:userId/opened is the only thing that sets an open receipt', async () => {
  let openSql = null;
  on(/FROM user_blocks WHERE \(blocker_id = \$1 AND blocked_id = \$2\)/, () => ({ rows: [], rowCount: 0 }));
  // Neither gate fires for this pair: not blocked, and the counterparty is not
  // banned. The route asks the second one about user 2 alone now, so this says
  // "no such banned row" for the id it is actually given rather than for the
  // whole product.
  on(/^SELECT 1 FROM users WHERE id = \$1 AND is_banned IS TRUE$/, () => ({ rows: [], rowCount: 0 }));
  on(/^UPDATE direct_messages SET opened_at = NOW\(\)/, (p, sql) => {
    openSql = sql;
    assert.deepStrictEqual(p, [1, 2, 41]);
    return { rows: [{ id: 41 }], rowCount: 1 };
  });

  const res = await call('PUT', '/api/dm/2/opened', { lastMessageId: 41 });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.openedMessageIds, [41]);
  // Opened implies delivered, so every reader can test one column and the
  // impossible pair (opened, never delivered) cannot be stored.
  assert.match(openSql, /delivered_at = COALESCE\(delivered_at, NOW\(\)\)/);
  assert.match(openSql, /opened_at IS NULL/, 'idempotent');

  const opened = emits.filter((e) => e.event === 'dm_opened');
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(opened[0].room, 'user:2');
  assert.deepStrictEqual(opened[0].payload, { withUserId: 1, messageIds: [41] });
});

test('a blocked pair receipts nothing in either direction', async () => {
  on(/FROM user_blocks WHERE \(blocker_id = \$1 AND blocked_id = \$2\)/, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
  on(/^UPDATE direct_messages/, () => { throw new Error('a blocked pair must not write a receipt'); });

  const res = await call('PUT', '/api/dm/2/opened', { lastMessageId: 41 });
  assert.strictEqual(res.status, 403, res.text);
  assert.strictEqual(emits.length, 0);
});

test('a banned counterpart receipts nothing either', async () => {
  on(/FROM user_blocks WHERE \(blocker_id = \$1 AND blocked_id = \$2\)/, () => ({ rows: [], rowCount: 0 }));
  // The ban is stated the way the route now asks for it: user 2 is banned, as a
  // pair question about user 2. It used to be stated by handing back a whole
  // invisible set with 2 in it, which is the same fact through a statement this
  // route no longer runs. Deliberately keyed on the id, so a route that asked
  // about the WRONG person — the caller, say — would get "not banned", write the
  // receipt, and fail this test instead of passing it by accident.
  on(/^SELECT 1 FROM users WHERE id = \$1 AND is_banned IS TRUE$/, (p) => (
    Number(p[0]) === 2 ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
  ));
  on(/^UPDATE direct_messages/, () => { throw new Error('a banned counterpart must not write a receipt'); });

  const res = await call('PUT', '/api/dm/2/opened', { lastMessageId: 41 });
  assert.strictEqual(res.status, 403, res.text);
  assert.strictEqual(emits.length, 0, 'and nothing was announced to either side');
});

test('the marker refuses a blocked pair even when a caller forgets to check', async () => {
  // markDmDelivered / markDmOpened are called from four places. The block gate
  // lives INSIDE them, and fails closed, so one forgetful call site cannot open
  // a live channel between two people who blocked each other.
  on(/FROM user_blocks WHERE \(blocker_id = \$1 AND blocked_id = \$2\)/, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
  on(/^UPDATE direct_messages/, () => { throw new Error('reached the UPDATE past a block'); });
  assert.deepStrictEqual(await socketHandlers.markDmDelivered(io, 1, 2, null), []);
  assert.deepStrictEqual(await socketHandlers.markDmOpened(io, 1, 2, null), []);
  assert.strictEqual(emits.length, 0);
});

test('a repeat receipt writes nothing and announces nothing', async () => {
  on(/FROM user_blocks WHERE \(blocker_id = \$1 AND blocked_id = \$2\)/, () => ({ rows: [], rowCount: 0 }));
  on(/^UPDATE direct_messages SET opened_at/, () => ({ rows: [], rowCount: 0 }));
  const ids = await socketHandlers.markDmOpened(io, 1, 2, 41);
  assert.deepStrictEqual(ids, []);
  assert.strictEqual(emits.length, 0, 'no rows moved, so nobody is told anything moved');
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE SEND ECHO
// ═════════════════════════════════════════════════════════════════════════════

test('a DM send echo says "sent", and the recipient\'s copy says nothing', async () => {
  on(/FROM user_blocks WHERE \(blocker_id = \$1 AND blocked_id = \$2\)/, () => ({ rows: [], rowCount: 0 }));
  on(/FROM friendships/, () => ({ rows: [{ ok: 1 }], rowCount: 1 }));
  on(/SELECT 1 FROM direct_messages/, () => ({ rows: [{ ok: 1 }], rowCount: 1 }));
  on(/^INSERT INTO direct_messages/, (p) => ({
    rows: [{ id: 77, sender_id: p[0], receiver_id: p[1], message_text: p[2], delivered_at: null, opened_at: null }],
    rowCount: 1,
  }));

  const res = await call('POST', '/api/dm/2', { message_text: 'on my way' });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.message.status, 'sent');
  await settle();

  const toRecipient = emits.find((e) => e.event === 'new_dm' && e.room === 'user:2');
  assert.ok(toRecipient, 'the recipient still gets the message');
  assert.strictEqual(toRecipient.payload.status, undefined,
    'a status on somebody else\'s row is a receipt about a message that is not theirs');
  const toSender = emits.find((e) => e.event === 'new_dm' && e.room === 'user:1');
  assert.strictEqual(toSender.payload.status, 'sent');
});

test('a DM to somebody with a live socket is delivered on the way out', async () => {
  ONLINE = new Set([2]);
  on(/FROM user_blocks WHERE \(blocker_id = \$1 AND blocked_id = \$2\)/, () => ({ rows: [], rowCount: 0 }));
  on(/FROM friendships/, () => ({ rows: [{ ok: 1 }], rowCount: 1 }));
  on(/SELECT 1 FROM direct_messages/, () => ({ rows: [{ ok: 1 }], rowCount: 1 }));
  on(/^INSERT INTO direct_messages/, () => ({ rows: [{ id: 77, sender_id: 1, receiver_id: 2 }], rowCount: 1 }));
  on(/^UPDATE direct_messages SET delivered_at = NOW\(\)/, (p) => {
    assert.deepStrictEqual(p, [2, 1, 77]);
    return { rows: [{ id: 77 }], rowCount: 1 };
  });

  const res = await call('POST', '/api/dm/2', { message_text: 'on my way' });
  assert.strictEqual(res.status, 201, res.text);
  await settle();

  const delivered = emits.filter((e) => e.event === 'dm_delivered');
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].room, 'user:1', 'the sender hears it, nobody else does');
  // Ordering: the sender's own new_dm echo has to land first or there is no row
  // for the receipt to attach to.
  const echoIndex = emits.findIndex((e) => e.event === 'new_dm' && e.room === 'user:1');
  const receiptIndex = emits.findIndex((e) => e.event === 'dm_delivered');
  assert.ok(echoIndex < receiptIndex, 'the echo precedes its own receipt');
});

test('a DM to somebody with no socket is not called delivered', async () => {
  ONLINE = new Set();
  on(/FROM user_blocks WHERE \(blocker_id = \$1 AND blocked_id = \$2\)/, () => ({ rows: [], rowCount: 0 }));
  on(/FROM friendships/, () => ({ rows: [{ ok: 1 }], rowCount: 1 }));
  on(/SELECT 1 FROM direct_messages/, () => ({ rows: [{ ok: 1 }], rowCount: 1 }));
  on(/^INSERT INTO direct_messages/, () => ({ rows: [{ id: 77, sender_id: 1, receiver_id: 2 }], rowCount: 1 }));
  on(/^UPDATE direct_messages SET delivered_at/, () => {
    throw new Error('nothing reached a device, so nothing may claim it did');
  });

  const res = await call('POST', '/api/dm/2', { message_text: 'on my way' });
  assert.strictEqual(res.status, 201, res.text);
  await settle();
  assert.strictEqual(emits.filter((e) => e.event === 'dm_delivered').length, 0);
});

test('a flock send echo says "sent" and delivers to the members who are connected', async () => {
  ONLINE = new Set([3]);
  on(/^SELECT id FROM flock_members WHERE flock_id/, () => ({ rows: [{ id: 10 }], rowCount: 1 }));
  on(/^INSERT INTO messages/, (p) => ({
    rows: [{ id: 500, flock_id: p[0], sender_id: p[1], message_text: p[2] }], rowCount: 1,
  }));
  on(/SELECT name FROM flocks WHERE id/, () => ({ rows: [{ name: 'Friday' }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id/, () => ({
    rows: [{ user_id: 2 }, { user_id: 3 }], rowCount: 2,
  }));
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/^UPDATE flock_members SET last_delivered_message_id/, (p) => {
    // flockId arrives from the URL, so it is the string Express parsed, the
    // same value the INSERT above it already uses.
    assert.deepStrictEqual(p, ['7', [3], 500], 'only the connected member');
    return { rows: [{ user_id: 3, last_delivered_message_id: 500, last_opened_message_id: 0 }], rowCount: 1 };
  });

  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'running late' });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.message.status, 'sent');
  await settle();

  // The members' copies carry no receipt. The sender's own account gets one
  // copy of its own, for its other devices, and that one is the 'sent' echo.
  const fanout = emits.filter((e) => e.event === 'new_message' && e.room !== 'user:1');
  assert.deepStrictEqual(fanout.map((e) => e.room).sort(), ['user:2', 'user:3']);
  for (const e of fanout) assert.strictEqual(e.payload.status, undefined);
  const own = emits.filter((e) => e.event === 'new_message' && e.room === 'user:1');
  assert.strictEqual(own.length, 1);
  assert.strictEqual(own[0].payload.status, 'sent');

  const read = emits.filter((e) => e.event === 'flock_read');
  assert.strictEqual(read.length, 1);
  assert.strictEqual(read[0].room, 'user:1', 'the sender hears it; the rest of the room reads its own roster');
  assert.strictEqual(read[0].payload.userId, 3);
  assert.strictEqual(read[0].payload.lastOpenedMessageId, 0, 'connected is not read');
});

test('a blocked member never appears in a delivery sweep', async () => {
  ONLINE = new Set([2, 3]);
  on(/^SELECT id FROM flock_members WHERE flock_id/, () => ({ rows: [{ id: 10 }], rowCount: 1 }));
  on(/^INSERT INTO messages/, () => ({ rows: [{ id: 500, flock_id: 7, sender_id: 1 }], rowCount: 1 }));
  on(/SELECT name FROM flocks WHERE id/, () => ({ rows: [{ name: 'Friday' }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id/, () => ({
    rows: [{ user_id: 2 }, { user_id: 3 }], rowCount: 2,
  }));
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [{ id: 2 }], rowCount: 1 }));
  on(/^UPDATE flock_members SET last_delivered_message_id/, (p) => {
    assert.deepStrictEqual(p[1], [3], 'the blocked member is not swept and not receipted');
    return { rows: [], rowCount: 0 };
  });

  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'running late' });
  assert.strictEqual(res.status, 201, res.text);
  await settle();
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. THE MIGRATION
// ═════════════════════════════════════════════════════════════════════════════

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

test('065 is the number the directory actually left free', () => {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
  const mine = files.filter((f) => f.startsWith('065_'));
  assert.strictEqual(mine.length, 1,
    `two files sharing a number is how 041 ended up written twice: ${mine.join(', ')}`);
  const numbers = files.map((f) => f.slice(0, 3));
  assert.strictEqual(new Set(numbers).size, numbers.length,
    'every migration number in the directory is used exactly once');
});

test('065 survives a replay over live data: it moves no rows', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS, '065_chat_read_receipts.sql'), 'utf8');
  const body = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  // migrationBootSafety wipes schema_migrations and runs the whole chain a
  // second time over a populated database, asserting not one row moves. A
  // backfill here would be caught there; this names the mistake where somebody
  // would make it.
  assert.ok(!/\b(INSERT|DELETE)\s+(INTO|FROM)\b/i.test(body), 'no data statements');
  assert.ok(!/^\s*UPDATE\s/im.test(body), 'no backfill: existing rows carry no receipt, which is the truth');
  // And it has to survive being applied twice in a row on its own terms.
  const alters = body.match(/ALTER TABLE[^;]+;/gi) || [];
  assert.strictEqual(alters.length, 4);
  for (const a of alters) assert.match(a, /ADD COLUMN IF NOT EXISTS/i, a);
  assert.match(body, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.match(sql.split('\n')[0], /^-- @noTransaction$/,
    'CREATE INDEX CONCURRENTLY cannot run inside a transaction block');
});

test('065 promises the four columns the code reads', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS, '065_chat_read_receipts.sql'), 'utf8');
  for (const col of [
    'direct_messages.delivered_at',
    'direct_messages.opened_at',
    'flock_members.last_delivered_message_id',
    'flock_members.last_opened_message_id',
  ]) {
    // The runner's post-condition check. 032 and 038 were both recorded as
    // applied with their columns absent because a swallowed lock_timeout looks
    // exactly like success; a file can declare what it must leave behind.
    assert.ok(sql.includes(`-- @requires column ${col}`), `065 must promise ${col}`);
  }
});

test('the watermark columns default to 0 rather than NULL', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS, '065_chat_read_receipts.sql'), 'utf8');
  // Every read is a >= comparison against the watermark. NULL >= anything is
  // NULL, which WHERE discards, so a member who had never opened anything
  // would drop out of the roster instead of reading as "opened nothing".
  const watermarks = sql.match(/ADD COLUMN IF NOT EXISTS last_(delivered|opened)_message_id[^;]*/g) || [];
  assert.strictEqual(watermarks.length, 2);
  for (const w of watermarks) assert.match(w, /INTEGER NOT NULL DEFAULT 0/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. THE SOCKET DOOR
// ═════════════════════════════════════════════════════════════════════════════

const HANDLERS_SRC = fs.readFileSync(path.join(__dirname, '..', 'sockets', 'handlers.js'), 'utf8');

test('four inbound receipt events exist, and they share one rate bucket', () => {
  for (const event of ['dm_ack', 'dm_open', 'flock_ack', 'flock_open']) {
    assert.ok(HANDLERS_SRC.includes(`socket.on('${event}'`), `${event} is not registered`);
  }
  // One bucket for all four, because the client batches them and they are
  // writes on the two hottest tables in the chat. Four independent allowances
  // would add up to four times the number that is written down.
  const buckets = HANDLERS_SRC.match(/allowEvent\(socket, 'receipt', RECEIPT_LIMIT, RECEIPT_WINDOW_MS\)/g) || [];
  assert.strictEqual(buckets.length, 4, 'every receipt event goes through the one bucket');
});

test('only the two _open doors may set an open receipt', () => {
  // The whole feature rests on this. markFlockOpened and markDmOpened are the
  // only writers of an open receipt, and a client saying "this thread is on
  // screen" is the only thing allowed to call them. If a history read, a push
  // tap, a presence check or the 056 badge cursor ever reaches one of these,
  // every "Opened" in the product becomes a guess.
  const callers = HANDLERS_SRC.match(/await mark(Flock|Dm)Opened\(/g) || [];
  assert.strictEqual(callers.length, 2, `markFlockOpened/markDmOpened called ${callers.length} times in handlers.js`);
  const flockOpen = HANDLERS_SRC.slice(
    HANDLERS_SRC.indexOf("socket.on('flock_open'"),
    HANDLERS_SRC.indexOf("socket.on('flock_open'") + 600
  );
  assert.match(flockOpen, /markFlockOpened\(io, flockId, user\.id, user\.name, upToId\)/);
  const dmOpen = HANDLERS_SRC.slice(
    HANDLERS_SRC.indexOf("socket.on('dm_open'"),
    HANDLERS_SRC.indexOf("socket.on('dm_open'") + 600
  );
  assert.match(dmOpen, /markDmOpened\(io, user\.id, withUserId, upToId\)/);

  const routesSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messages.js'), 'utf8');
  const routeCallers = routesSrc.match(/mark(Flock|Dm)Opened\(/g) || [];
  assert.strictEqual(routeCallers.length, 2, 'exactly two REST doors: PUT /flocks/:id/opened and PUT /dm/:userId/opened');
  // And the history reads reach for the DELIVERED marker, never the open one.
  const flockHistory = routesSrc.slice(
    routesSrc.indexOf("router.get('/flocks/:id/messages'"),
    routesSrc.indexOf("router.post('/flocks/:id/messages'")
  );
  assert.ok(flockHistory.includes('markFlockDelivered('), 'the history read marks delivery');
  assert.ok(!flockHistory.includes('markFlockOpened('), 'the history read must never mark an open');
});

test('a receipt never rides on a hidden or unsent message', () => {
  // Every other read path on direct_messages filters these two, so a receipt
  // on a taken-down or unsent row would be a receipt about content nobody is
  // allowed to see. The predicate is shared by both DM markers, which is why
  // it is one constant and not two copies that can drift.
  const scope = HANDLERS_SRC.slice(
    HANDLERS_SRC.indexOf('const DM_RECEIPT_SCOPE'),
    HANDLERS_SRC.indexOf('const DM_RECEIPT_SCOPE') + 300
  );
  assert.match(scope, /COALESCE\(is_hidden, false\) = false/);
  assert.match(scope, /sender_deleted_at IS NULL/);
  assert.match(scope, /receiver_id = \$1 AND sender_id = \$2/);
});

test('delivery may be claimed from a live socket, and attention may not', () => {
  // deliveredToLiveSocket wraps pushHelper's isUserOnline and answers false for
  // a broadcaster it cannot inspect, so an unreadable io proves no delivery
  // rather than asserting one.
  ONLINE = new Set([5]);
  assert.strictEqual(socketHandlers.deliveredToLiveSocket(io, 5), true, 'a socket in the room is a device');
  assert.strictEqual(socketHandlers.deliveredToLiveSocket(io, 6), false);
  assert.strictEqual(socketHandlers.deliveredToLiveSocket(UNINSPECTABLE, 5), false,
    'a broadcaster we cannot read names no device, so it proves no delivery');
  // And it is never consulted by an open receipt: presence is not attention.
  const openers = HANDLERS_SRC.slice(
    HANDLERS_SRC.indexOf('async function markFlockOpened'),
    HANDLERS_SRC.indexOf('const DM_RECEIPT_SCOPE')
  );
  assert.ok(!/deliveredToLiveSocket|isUserOnline/.test(openers));
});
