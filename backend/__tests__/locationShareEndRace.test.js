// Run: node --test  (from backend/)
//
// A POSITION THAT WAS ALREADY ON ITS WAY WHEN THE SHARE ENDED.
//
// update_location awaits the membership check and then the roster and block
// reads before it posts a position. Every way a share ends announces a stop
// (member_stopped_sharing) to the people holding the pin: the sharer's own
// stop, their leaving the plan, the plan being deleted, a dropped connection.
// A tick whose reads were still in flight when that stop went out used to
// resume afterwards, post the position to maps that had just cleared it, and
// record its audience as holding the pin again, and the sharer's app, having
// stopped, sent nothing that would end it a second time.
//
// Each stop now marks the share before its first await (markShareEnded in
// sockets/handlers.js), and a tick whose mark moved while it read is dropped.
// The leave route also repeats the stop from memory once the membership row
// is gone, for a tick that started between the first stop and the commit.
//
// No database and no real Socket.io. The tick's roster read is held open on a
// promise the test releases, which is the race made deterministic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'location-share-end-race-secret';

const pool = require('../config/database');

const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const {
  registerHandlers,
  __resetRateLimiters,
  announceFlockSharesEnded,
} = require('../sockets/handlers');

let routes = [];
function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  for (const [re, fn] of routes) {
    if (re.test(flat)) {
      return Promise.resolve().then(() => fn(params || [])).then((rows) => ({ rows }));
    }
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 140)}`));
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

test.after(() => { pool.end?.().catch(() => {}); });

function fakeSocket(user) {
  const handlers = new Map();
  const socket = {
    id: 's1',
    user,
    rooms: new Set(),
    handshake: null,
    on(event, handler) { handlers.set(event, handler); },
    join(room) { socket.rooms.add(room); },
    leave(room) { socket.rooms.delete(room); },
    emit() {},
    to() { return { except() { return this; }, emit() {} }; },
    disconnect() { socket.disconnected = true; },
    handlers,
  };
  return socket;
}

function fakeIo() {
  const emitted = [];
  return {
    emitted,
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
    to(room) {
      const op = { except() { return op; }, emit(event, payload) { emitted.push({ room, event, payload }); } };
      return op;
    },
  };
}

function connect() {
  __resetRateLimiters();
  routes = [];
  const io = fakeIo();
  const socket = fakeSocket({ id: 1, name: 'Ava' });
  registerHandlers(io, socket);
  return { io, socket };
}

const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);
const turn = () => new Promise((r) => setTimeout(r, 10));
const positions = (io) => io.emitted.filter((e) => e.event === 'location_update');
const stops = (io) => io.emitted.filter((e) => e.event === 'member_stopped_sharing');

const FLOCK = 5;
const MEMBERS = [{ user_id: 2 }, { user_id: 3 }];

/**
 * The roster read a tick makes is the same statement the stop's roster half
 * makes, so the FIRST one (the tick's) is held on `gate` and every later one
 * answers at once.
 */
function scriptShare(gate) {
  let rosterReads = 0;
  routes = [
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/, () => [{ id: 10 }]],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => {
      rosterReads += 1;
      return rosterReads === 1 && gate ? gate.then(() => MEMBERS) : MEMBERS;
    }],
    [/FROM user_blocks/, () => []],
  ];
}

function held() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

test('a position still reading its roster when the sharer stops is never posted', async () => {
  const { io, socket } = connect();
  const gate = held();
  scriptShare(gate.promise);

  const tick = fire(socket, 'update_location', { flockId: FLOCK, lat: 40.1, lng: -75.2 });
  await turn(); // the tick is now waiting on its roster
  await fire(socket, 'stop_sharing_location', { flockId: FLOCK });
  assert.deepStrictEqual(stops(io).map((e) => e.room).sort(), ['user:2', 'user:3'], 'the stop went out');

  gate.release();
  await tick;

  assert.deepStrictEqual(positions(io), [], 'the position was posted after the stop had cleared it');
  // Nor did it record anybody as holding the pin: a plan delete now finds
  // nobody to tell, because nobody holds anything.
  io.emitted.length = 0;
  announceFlockSharesEnded(io, FLOCK);
  assert.deepStrictEqual(stops(io), []);
});

test('a position still in flight when the plan is deleted is never posted', async () => {
  const { io, socket } = connect();
  const gate = held();
  scriptShare(gate.promise);

  const tick = fire(socket, 'update_location', { flockId: FLOCK, lat: 40.1, lng: -75.2 });
  await turn();
  // The delete routes call this once the delete has committed. A first tick
  // has recorded no holders yet, so this is also the case a restart leaves.
  announceFlockSharesEnded(io, FLOCK);
  gate.release();
  await tick;

  assert.deepStrictEqual(positions(io), []);
});

test('a share that starts after a stop is delivered as usual', async () => {
  // The mark is read when a tick ARRIVES, so a stop in the past is not a
  // reason to drop a new share: only a stop during the tick's own reads is.
  const { io, socket } = connect();
  scriptShare(null);
  await fire(socket, 'stop_sharing_location', { flockId: FLOCK });
  io.emitted.length = 0;

  await fire(socket, 'update_location', { flockId: FLOCK, lat: 40.1, lng: -75.2 });

  assert.deepStrictEqual(positions(io).map((e) => e.room).sort(), ['user:2', 'user:3']);
});

test('an ordinary tick with no stop anywhere near it is untouched', async () => {
  const { io, socket } = connect();
  scriptShare(null);
  await fire(socket, 'update_location', { flockId: FLOCK, lat: 40.1, lng: -75.2 });
  await fire(socket, 'update_location', { flockId: FLOCK, lat: 40.2, lng: -75.3 });
  assert.strictEqual(positions(io).length, 4, 'two members, two ticks');
});

test("another sharer's stop does not drop this sharer's position", async () => {
  // The mark is per sharer within a plan (and per plan for a delete).
  const { io, socket } = connect();
  const gate = held();
  scriptShare(gate.promise);
  const tick = fire(socket, 'update_location', { flockId: FLOCK, lat: 40.1, lng: -75.2 });
  await turn();
  // Member 2 stops their own share in the same plan, through the same path
  // the leave route and the disconnect use.
  const { announceFlockShareEnded } = require('../sockets/handlers');
  await announceFlockShareEnded(io, 2, FLOCK, { roster: false });
  gate.release();
  await tick;
  assert.deepStrictEqual(positions(io).map((e) => e.room).sort(), ['user:2', 'user:3']);
});

test('the leave route repeats the stop from memory once the membership row is gone', () => {
  // A tick that STARTED between the first stop (sent while the row still
  // stood, so the roster could be read) and the commit passed the membership
  // check and posted. Every later position is refused, so nothing would take
  // that one back unless the stop is repeated after the commit.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flocks.js'), 'utf8').replace(/\r\n/g, '\n');
  const commit = src.indexOf("await leaveClient.query('COMMIT');");
  assert.ok(commit > 0, 'the leave transaction is where this test expects it');
  const after = src.slice(commit, commit + 2500);
  assert.match(after, /if \(io && wasAccepted\) await announceFlockShareEnded\(io, req\.user\.id, flockId, \{ roster: false \}\);/);
});
