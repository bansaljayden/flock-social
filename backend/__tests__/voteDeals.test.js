// Run: node --test  (from backend/)
//
// A VENUE'S DEAL ON ITS OPTION IN A FLOCK'S VOTE (routes/venues.js
// voteDealsFor, 2026-11-03).
//
// Each option with a place id carries the deal that member's venue page would
// lead with, decided by utils/venueDeals.js, so a drink deal reaches only a
// member we know is 21. `new_vote` has two producers, the REST vote and the
// socket vote_venue, and both are walked here with a scripted database: every
// member's payload, the voter's own answer, the GET, a deals read that fails,
// and the statements it costs. venueDealsParity.test.js walks the REST half on
// a real Postgres beside the venue page.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'vote-deals-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

// Both files destructure these at load: replaced first, so nothing is pushed.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const authMod = require('../middleware/auth');
let CURRENT_USER = null;
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// --- the world -------------------------------------------------------------

const FLOCK = 42;
const TAQ = 'ChIJvoteDealsTaq001';
const BRUNCH = 'ChIJvoteDealsBrunch2';
const QUIET = 'ChIJvoteDealsQuiet03';
const YEAR = new Date().getUTCFullYear();
const ADA = { id: 1, name: 'Ada', dob: `${YEAR - 30}-01-01` };
const MILO = { id: 2, name: 'Milo', dob: `${YEAR - 16}-06-15` };
const NICO = { id: 3, name: 'Nico', dob: null };
const PEOPLE = [ADA, MILO, NICO];

// The deals the venue pages serve before the 21 rule, newest first. The
// basket is a drink deal by its Custom time slot, the mimosas by their title.
const DEALS = {
  [TAQ]: [
    { id: 11, title: 'Wings basket', description: null, time_slot: '5 to 7, happy hour', days: 'Daily' },
    { id: 12, title: 'Free churros with any entree', description: null, time_slot: '5 to 7pm', days: 'Tuesday to Thursday' },
  ],
  [BRUNCH]: [{ id: 21, title: 'Bottomless mimosas', description: 'With any entree', time_slot: 'Weekend Brunch', days: 'Weekends' }],
};
const BASKET = { title: 'Wings basket', time_slot: '5 to 7, happy hour', days: 'Daily' };
const CHURROS = { title: 'Free churros with any entree', time_slot: '5 to 7pm', days: 'Tuesday to Thursday' };
const MIMOSAS = { title: 'Bottomless mimosas', time_slot: 'Weekend Brunch', days: 'Weekends' };

let votes;          // { user_id, venue_name, venue_id }
let calls;
let dealsFail;
let txn = null;

function reset() {
  votes = [
    { user_id: ADA.id, venue_name: 'Taqueria', venue_id: TAQ },
    { user_id: MILO.id, venue_name: 'Brunch Spot', venue_id: BRUNCH },
    { user_id: NICO.id, venue_name: 'Quiet Cafe', venue_id: QUIET },
  ];
  calls = [];
  dealsFail = false;
  txn = null;
}
reset();

function tally() {
  const byName = new Map();
  for (const v of votes) {
    if (!byName.has(v.venue_name)) byName.set(v.venue_name, { venue_name: v.venue_name, venue_id: v.venue_id, member_count: 0, voter_rows: [] });
    const g = byName.get(v.venue_name);
    g.member_count += 1;
    g.voter_rows.push({ id: v.user_id, name: PEOPLE.find((p) => p.id === v.user_id).name });
  }
  return [...byName.values()];
}

async function dispatch(sql, params = []) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  calls.push({ sql: flat, params });
  const out = (rows, rowCount = rows.length) => ({ rows, rowCount });
  if (/^BEGIN/.test(flat)) { txn = votes.map((v) => ({ ...v })); return out([]); }
  if (/^ROLLBACK/.test(flat)) { if (txn) votes = txn; txn = null; return out([]); }
  if (/^COMMIT/.test(flat)) { txn = null; return out([]); }
  if (/pg_advisory_xact_lock/.test(flat)) return out([]);
  if (/^SELECT id FROM flocks WHERE id = \$1 FOR KEY SHARE$/.test(flat)) return out([{ id: FLOCK }]);
  if (/^SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'$/.test(flat)) {
    return PEOPLE.some((p) => p.id === Number(params[1])) ? out([{ id: 1 }]) : out([]);
  }
  if (/^SELECT status FROM flocks WHERE id = \$1$/.test(flat)) return out([{ status: 'planning' }]);
  if (/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/.test(flat)) {
    return out(PEOPLE.map((p) => ({ user_id: p.id })));
  }
  if (/FROM user_blocks/.test(flat)) return out([]);
  if (/^SELECT venue_name FROM venue_votes WHERE flock_id = \$1 AND user_id = \$2$/.test(flat)) {
    return out(votes.filter((v) => v.user_id === Number(params[1])).map((v) => ({ venue_name: v.venue_name })));
  }
  if (/^DELETE FROM venue_votes WHERE flock_id = \$1 AND user_id = \$2 AND venue_name <> \$3$/.test(flat)) {
    const before = votes.length;
    votes = votes.filter((v) => !(v.user_id === Number(params[1]) && v.venue_name !== params[2]));
    return out([], before - votes.length);
  }
  if (/^INSERT INTO venue_votes/.test(flat)) {
    const [, uid, name, vid] = params;
    let v = votes.find((x) => x.user_id === Number(uid) && x.venue_name === name);
    if (!v) { v = { user_id: Number(uid), venue_name: name, venue_id: vid }; votes.push(v); }
    return out([{ flock_id: FLOCK, ...v }]);
  }
  if (/FROM venue_votes vv/.test(flat)) return out(tally());
  if (/FROM guest_votes gv/.test(flat)) return out([]);
  // utils/venueDeals.js: one venue's statement or the batch.
  if (/FROM venue_promotions p/.test(flat)) {
    if (dealsFail) throw new Error('canceling statement due to statement timeout');
    const asked = Array.isArray(params[0]) ? params[0] : [params[0]];
    const batch = Array.isArray(params[0]);
    return out(asked.flatMap((place) => (DEALS[place] || []).map((d) => (batch ? { ...d, google_place_id: place } : d))));
  }
  if (/^SELECT id, date_of_birth FROM users WHERE id = ANY\(\$1::int\[\]\)$/.test(flat)) {
    return out(PEOPLE.filter((p) => params[0].includes(p.id)).map((p) => ({ id: p.id, date_of_birth: p.dob })));
  }
  if (/^SELECT date_of_birth FROM users WHERE id = \$1$/.test(flat)) {
    return out(PEOPLE.filter((p) => p.id === Number(params[0])).map((p) => ({ date_of_birth: p.dob })));
  }
  // utils/blocks.js getInvisibleUserIds, for the GET.
  if (/^SELECT blocked_id AS id FROM user_blocks/.test(flat)) return out([]);
  throw new Error(`unscripted query: ${flat.slice(0, 140)}`);
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

const venuesRouter = require('../routes/venues');
const { tailorVotes, voteDealsFor } = venuesRouter;
const { registerHandlers, __resetRateLimiters } = require('../sockets/handlers');

// Every room an event was addressed to.
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

let io = fakeIo();
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.app.set('io', io); next(); });
app.use('/api/flocks', venuesRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); })));
test.after(() => new Promise((resolve) => { server.close(() => resolve()); pool.end?.().catch(() => {}); }));
test.beforeEach(() => { reset(); io = fakeIo(); });

async function call(method, url, who, body) {
  CURRENT_USER = { id: who.id, name: who.name, email_verified: true, role: 'user' };
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

const dealsByName = (rows) => Object.fromEntries((rows || []).map((o) => [o.venue_name, 'deal' in o ? o.deal : 'none']));
const toRoom = (who) => io.emitted.find((e) => e.room === `user:${who.id}` && e.event === 'new_vote');

// ===========================================================================
// tailorVotes
// ===========================================================================

test('a row carries the recipient\'s deal when its venue has one, and no deal key otherwise', () => {
  const rows = [
    { venue_name: 'Taqueria', venue_id: TAQ, member_count: 2, guest_count: 0, guest_weight: 0, voter_rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Milo' }] },
    { venue_name: 'Typed in', venue_id: null, member_count: 1, guest_count: 0, guest_weight: 0, voter_rows: [{ id: 3, name: 'Nico' }] },
    { venue_name: 'Quiet Cafe', venue_id: QUIET, member_count: 1, guest_count: 0, guest_weight: 0, voter_rows: [{ id: 3, name: 'Nico' }] },
  ];
  // A deal keyed to a place no row names, and one keyed to the null id, reach nobody.
  const deals = new Map([[TAQ, CHURROS], ['ChIJsomewhereElse1', MIMOSAS], [null, BASKET]]);
  const names = tailorVotes(rows, new Set(), { viewerId: 1, deals });
  assert.deepStrictEqual(names[0], { venue_name: 'Taqueria', venue_id: TAQ, vote_count: 2, guest_count: 0, voters: ['Ada', 'Milo'], mine: true, deal: CHURROS });
  assert.ok(!('deal' in names[1]) && !('deal' in names[2]));
  // The GET's { id, name } shape carries it the same way.
  const objects = tailorVotes(rows, new Set(), { voterObjects: true, deals });
  assert.deepStrictEqual(objects[0].deal, CHURROS);
  // No deals handed in is the shape every recipient was sent before.
  assert.deepStrictEqual(Object.keys(tailorVotes(rows, new Set(), { viewerId: 1 })[0]).sort(), ['guest_count', 'mine', 'venue_id', 'venue_name', 'vote_count', 'voters']);
});

test('voteDealsFor: one deals statement and one birthday read for every member, each answered for themselves', async () => {
  const dealsOf = await voteDealsFor(tally(), PEOPLE.map((p) => p.id));
  assert.strictEqual(calls.filter((c) => /FROM venue_promotions p/.test(c.sql)).length, 1);
  assert.strictEqual(calls.filter((c) => /FROM users WHERE id = ANY/.test(c.sql)).length, 1);
  assert.deepStrictEqual([...dealsOf(ADA.id)], [[TAQ, BASKET], [BRUNCH, MIMOSAS]]);
  assert.deepStrictEqual([...dealsOf(MILO.id)], [[TAQ, CHURROS]]);
  assert.strictEqual(dealsOf(NICO.id), dealsOf(MILO.id), 'two members who see the same deals share one answer');
});

test('voteDealsFor: no place id among the options asks nothing', async () => {
  const dealsOf = await voteDealsFor([{ venue_name: 'Typed in', venue_id: null }, { venue_name: 'Legacy', venue_id: 'abc' }], [ADA.id]);
  assert.strictEqual(dealsOf(ADA.id).size, 0);
  assert.strictEqual(calls.length, 0);
});

// ===========================================================================
// The REST vote
// ===========================================================================

test('GET /votes: each member reads their own deal on each option', async () => {
  const expected = {
    [ADA.id]: { Taqueria: BASKET, 'Brunch Spot': MIMOSAS, 'Quiet Cafe': 'none' },
    [MILO.id]: { Taqueria: CHURROS, 'Brunch Spot': 'none', 'Quiet Cafe': 'none' },
    [NICO.id]: { Taqueria: CHURROS, 'Brunch Spot': 'none', 'Quiet Cafe': 'none' },
  };
  for (const who of PEOPLE) {
    const r = await call('GET', `/api/flocks/${FLOCK}/votes`, who);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(dealsByName(r.body.votes), expected[who.id], who.name);
  }
});

test('POST /vote: the voter\'s answer and every member\'s new_vote carry that member\'s own deals', async () => {
  const r = await call('POST', `/api/flocks/${FLOCK}/vote`, MILO, { venue_name: 'Taqueria', venue_id: TAQ });
  assert.strictEqual(r.status, 201, r.text);
  assert.deepStrictEqual(dealsByName(r.body.votes), { Taqueria: CHURROS, 'Quiet Cafe': 'none' });
  assert.deepStrictEqual(io.emitted.map((e) => e.room).sort(), ['user:1', 'user:3']);
  assert.deepStrictEqual(dealsByName(toRoom(ADA).payload.votes), { Taqueria: BASKET, 'Quiet Cafe': 'none' });
  assert.deepStrictEqual(dealsByName(toRoom(NICO).payload.votes), { Taqueria: CHURROS, 'Quiet Cafe': 'none' });
  assert.strictEqual(calls.filter((c) => /FROM venue_promotions p/.test(c.sql)).length, 1, 'one deals read for the whole fan-out');
});

test('a deals read that fails costs the options their deals, never the vote', async () => {
  dealsFail = true;
  const r = await call('POST', `/api/flocks/${FLOCK}/vote`, ADA, { venue_name: 'Brunch Spot', venue_id: BRUNCH });
  assert.strictEqual(r.status, 201, r.text);
  assert.ok(Array.isArray(r.body.votes), 'the tally is still answered');
  assert.ok(r.body.votes.every((o) => !('deal' in o)));
  for (const e of io.emitted) assert.ok(e.payload.votes.every((o) => !('deal' in o)), e.room);
  assert.deepStrictEqual(votes.find((v) => v.user_id === ADA.id).venue_name, 'Brunch Spot', 'the vote is stored');
  const g = await call('GET', `/api/flocks/${FLOCK}/votes`, ADA);
  assert.strictEqual(g.status, 200, g.text);
  assert.ok(g.body.votes.every((o) => !('deal' in o)));
});

// ===========================================================================
// The socket vote
// ===========================================================================

test('vote_venue: the voter and every member are sent their own view of each option\'s deal', async () => {
  __resetRateLimiters();
  const sockIo = fakeIo();
  const emitted = [];
  const handlers = new Map();
  const socket = {
    id: 's-milo',
    user: { id: MILO.id, name: MILO.name },
    rooms: new Set(),
    handshake: null,
    on(event, h) { handlers.set(event, h); },
    join(room) { socket.rooms.add(room); },
    leave(room) { socket.rooms.delete(room); },
    emit(event, payload) { emitted.push({ target: 'self', event, payload }); },
    to(room) { const op = { except() { return op; }, emit(event, payload) { emitted.push({ target: room, event, payload }); } }; return op; },
    disconnect() {},
  };
  registerHandlers(sockIo, socket);
  emitted.length = 0;
  calls = [];

  await handlers.get('vote_venue')({ flockId: FLOCK, venue_name: 'Taqueria', venue_id: TAQ });

  const self = emitted.find((e) => e.target === 'self' && e.event === 'new_vote');
  assert.ok(self, `no new_vote to the voter: ${JSON.stringify(emitted.map((e) => e.event))}`);
  assert.deepStrictEqual(dealsByName(self.payload.votes), { Taqueria: CHURROS, 'Quiet Cafe': 'none' }, 'the 16-year-old voter');
  const forAda = sockIo.emitted.find((e) => e.room === `user:${ADA.id}`);
  const forNico = sockIo.emitted.find((e) => e.room === `user:${NICO.id}`);
  assert.deepStrictEqual(dealsByName(forAda.payload.votes), { Taqueria: BASKET, 'Quiet Cafe': 'none' });
  assert.deepStrictEqual(dealsByName(forNico.payload.votes), { Taqueria: CHURROS, 'Quiet Cafe': 'none' });
  assert.strictEqual(sockIo.emitted.some((e) => e.room === `user:${MILO.id}`), false, 'the voter hears it on their own socket, once');
  assert.strictEqual(calls.filter((c) => /FROM venue_promotions p/.test(c.sql)).length, 1);
  assert.strictEqual(calls.filter((c) => /FROM users WHERE id = ANY/.test(c.sql)).length, 1);
});
