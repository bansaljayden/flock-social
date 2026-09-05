// Run: node --test  (from backend/)
//
// SYSTEM MESSAGES: the plan's own events in the stream (migration 067).
//
// components/chat/cards/SystemRow.js was built, tested and exported, and its
// own header says the events it draws "are not in the stream at all". It could
// not be otherwise: the CHECK on messages.message_type has allowed exactly
// three values since the bootstrap schema, so a system row was not merely
// unwired, it was UNSTORABLE. Every read path filtered a value nothing could
// write. Migration 016 fixed that same shape for content_reports.content_type
// and its header records the shape having shipped twice before; this was the
// third instance.
//
// The two things this file guards hardest are the ones that are quiet when
// broken: a client must never be able to author a system row, and a system row
// must not reach somebody who blocked the person it names.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'flock-system-message-secret';

const pool = require('../config/database');

const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const moderationMod = require('../utils/moderation');
moderationMod.moderateImage = async () => ({ allowed: true, reason: null });

const { registerHandlers, __resetRateLimiters } = require('../sockets/handlers');
const { SYSTEM_KINDS, writeSystemMessage } = require('../utils/systemMessages');

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

function connect(user = { id: 1, name: 'Maya' }) {
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
const systemInserts = () => calls.filter((c) => /INSERT INTO messages .*'system'/i.test(c.sql));
const sysRows = (io) => io.emitted.filter((e) => e.event === 'new_message' && e.payload?.message_type === 'system');

const MEMBERS = [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }];

/** @param opts.currentVenue what the flock already has  @param opts.blocks ids invisible to the actor */
function scriptSelectVenue({ currentVenue = null, blocks = [] } = {}) {
  routes = [
    [/SELECT creator_id, venue_name FROM flocks/, [{ creator_id: 1, venue_name: currentVenue }]],
    [/UPDATE flocks/, []],
    [/FROM user_blocks/, blocks.map((id) => ({ id }))],
    [/INSERT INTO messages/, (p) => [{
      id: 900, flock_id: p[0], sender_id: p[1], message_text: p[2],
      message_type: 'system', system_kind: p[3], created_at: '2026-09-05T20:00:00Z',
    }]],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/, MEMBERS],
  ];
}

// ---------------------------------------------------------------------------
// 1. The event reaches the stream at all
// ---------------------------------------------------------------------------

test('confirming a venue writes a system row naming the actor and the venue', async () => {
  const { io, socket } = connect();
  scriptSelectVenue({ currentVenue: null });

  await fire(socket, 'select_venue', { flockId: 3, venue_name: 'Kome' });

  const inserts = systemInserts();
  assert.strictEqual(inserts.length, 1, 'the decision must survive not being looked at');
  assert.deepStrictEqual(inserts[0].params, [3, 1, 'Kome', SYSTEM_KINDS.VENUE_SET]);
});

test('the row carries the KIND and the value, never a finished sentence', async () => {
  const { io, socket } = connect();
  scriptSelectVenue({ currentVenue: null });

  await fire(socket, 'select_venue', { flockId: 3, venue_name: 'Kome' });

  const row = sysRows(io)[0];
  assert.ok(row, 'members receive it live');
  assert.strictEqual(row.payload.system_kind, 'venue_set');
  assert.strictEqual(row.payload.message_text, 'Kome');
  // SystemRow's contract is that it receives pieces and decides the accent.
  // A server sending prose would be choosing the wording for a component
  // documented not to receive any.
  assert.ok(!/set the venue/i.test(row.payload.message_text),
    'the server must not assemble the sentence');
});

test('re-confirming the SAME venue narrates nothing', async () => {
  const { socket } = connect();
  scriptSelectVenue({ currentVenue: 'Kome' });

  await fire(socket, 'select_venue', { flockId: 3, venue_name: 'Kome' });

  assert.strictEqual(systemInserts().length, 0,
    'a creator double-tapping, or a client retrying, must not stack identical lines');
});

// ---------------------------------------------------------------------------
// 2. A system row must not reach somebody who blocked the person it names
// ---------------------------------------------------------------------------

test('a member who blocked the actor is not handed the row', async () => {
  const { io, socket } = connect();
  scriptSelectVenue({ currentVenue: 'Old Bar', blocks: [3] });

  await fire(socket, 'select_venue', { flockId: 3, venue_name: 'Kome' });

  const rooms = sysRows(io).map((e) => e.room);
  assert.ok(rooms.includes('user:2'), 'an unrelated member gets it');
  assert.ok(rooms.includes('user:1'), 'the actor sees their own action recorded');
  assert.ok(!rooms.includes('user:3'), 'the blocker must not be told, by name, what the blocked person did');
});

test('the row is fanned out per member, never to the flock room', async () => {
  const { io, socket } = connect();
  scriptSelectVenue({ currentVenue: 'Old Bar' });

  await fire(socket, 'select_venue', { flockId: 3, venue_name: 'Kome' });

  // A room broadcast is how blocked users reached their blocker's open client
  // before; the comment on the ordinary send path records it.
  for (const e of sysRows(io)) {
    assert.match(e.room, /^user:\d+$/, `system rows must not go to ${e.room}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Failure isolation: a note about a plan change cannot fail the change
// ---------------------------------------------------------------------------

test('a failed system write does not fail the venue confirmation', async () => {
  const { io, socket } = connect();
  routes = [
    [/SELECT creator_id, venue_name FROM flocks/, [{ creator_id: 1, venue_name: null }]],
    [/UPDATE flocks/, []],
    [/FROM user_blocks/, []],
    // The insert is the only thing that fails.
    [/SELECT user_id FROM flock_members/, MEMBERS],
  ];

  await fire(socket, 'select_venue', { flockId: 3, venue_name: 'Kome' });

  const errs = socket.emitted.filter((e) => e.event === 'error');
  assert.deepStrictEqual(errs, [], 'the venue IS confirmed; there is nothing to tell the user');
  assert.ok(io.emitted.some((e) => e.event === 'venue_selected'), 'the plan change still broadcasts');
});

test('writeSystemMessage refuses an empty value and an unknown kind', async () => {
  routes = [[/INSERT INTO messages/, [{ id: 1 }]]];
  calls = [];
  assert.strictEqual(await writeSystemMessage(3, 1, SYSTEM_KINDS.VENUE_SET, '   '), null,
    'an empty row draws a grey line the reader has to interpret, and message_text is NOT NULL');
  assert.strictEqual(await writeSystemMessage(3, 1, 'not_a_kind', 'Kome'), null);
  assert.strictEqual(calls.length, 0, 'neither may reach the database');
});

// ---------------------------------------------------------------------------
// 4. A CLIENT MUST NEVER AUTHOR ONE
// ---------------------------------------------------------------------------

const HANDLERS_SRC = fs.readFileSync(path.join(__dirname, '..', 'sockets', 'handlers.js'), 'utf8').replace(/\r\n/g, '\n');
const ROUTES_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messages.js'), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '067_flock_system_messages.sql'), 'utf8'
).replace(/\r\n/g, '\n');

test("no client-facing type list learned 'system'", () => {
  /* A client that could author a system row could forge "Maya set the venue:
     <somewhere else>" in the app's OWN voice, which reads as the product
     speaking rather than as a person, and so is worse than ordinary
     impersonation. Four lists stand between the wire and that: two
     allowedTypes on the socket sends, two express-validator isIn chains. All
     four are asserted here, as absences, because the danger is a future edit
     adding 'system' to one of them for symmetry. */
  const allowed = HANDLERS_SRC.match(/const allowedTypes = \[[^\]]*\]/g) || [];
  assert.strictEqual(allowed.length, 2, 'both socket send paths still clamp the type');
  for (const list of allowed) {
    assert.ok(!list.includes('system'), `a socket send path accepts 'system': ${list}`);
  }

  const validators = ROUTES_SRC.match(/'message type'\)\.isIn\(\[[^\]]*\]\)/g) || [];
  assert.strictEqual(validators.length, 2, 'both REST senders still validate the type');
  for (const v of validators) {
    assert.ok(!v.includes('system'), `a REST validator accepts 'system': ${v}`);
  }
});

test('writeSystemMessage is the only writer, and nothing on the wire reaches it', () => {
  const callers = HANDLERS_SRC.match(/writeSystemMessage\(/g) || [];
  assert.strictEqual(callers.length, 1, 'one caller: the venue confirmation');
  // The caller sits behind the creator check, so a member cannot trigger one
  // for a flock they are merely in.
  const at = HANDLERS_SRC.indexOf('writeSystemMessage(flockId');
  const before = HANDLERS_SRC.slice(0, at);
  assert.ok(before.lastIndexOf('Only the flock creator can select a venue') > before.lastIndexOf("socket.on('select_venue'"),
    'the write must sit behind the creator check');
});

// ---------------------------------------------------------------------------
// 5. The migration
// ---------------------------------------------------------------------------

test('the migration widens the CHECK rather than leaving it to drift again', () => {
  assert.match(MIGRATION, /DROP CONSTRAINT IF EXISTS messages_message_type_check/);
  assert.match(MIGRATION, /CHECK \(message_type IN \('text', 'venue_card', 'image', 'system'\)\)/);
  assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS system_kind VARCHAR\(32\)/);
});

test('system_kind carries NO check constraint, deliberately', () => {
  /* Adding one would be a fourth instance of the exact bug this migration
     fixes: a route learns a new value, the constraint does not, and the INSERT
     dies as a 23514 that the route turns into a 500 on a feature nobody can
     reach. The client renders an unknown kind as nothing, so an unrecognised
     value is inert instead of fatal. */
  assert.ok(!/system_kind[^;]*CHECK/i.test(MIGRATION),
    'a CHECK here recreates the drift that made system rows unstorable for months');
});

test('the migration is Latin-1 clean, which the boot-safety test requires', () => {
  const offending = [...MIGRATION].filter((ch) => ch.charCodeAt(0) > 255);
  assert.deepStrictEqual(offending, [], `non-Latin-1 characters: ${offending.join(' ')}`);
});
