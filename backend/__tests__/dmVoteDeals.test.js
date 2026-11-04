// Run: node --test  (from backend/)
//
// A VENUE'S DEAL ON ITS OPTION IN A DM'S VOTE (sockets/handlers.js
// dmVotesFor, 2026-11-03).
//
// Two people choosing a place in a direct message vote on venues the way a
// flock does, and each option with a place id now carries the deal that
// person's venue page would lead with, decided by utils/venueDeals.js through
// the read a flock's vote makes (routes/venues.js voteDealsFor). The two are
// told apart: a drink deal reaches only a person we know is 21, so in a thread
// between Ada (30) and Tess (19) Tess is never sent it, whoever voted, and Ada
// is. Walked here with a scripted database over every door the tally leaves
// by: GET /api/dm/:userId/venue-votes for each of the two, the POST answer for
// a vote and for the un-vote it toggles, both copies of the socket's
// dm_new_vote for a vote and an un-vote, a deals read that fails, a birthday
// read that fails, and the statements it costs. venueDealsParity.test.js walks
// the REST half on a real Postgres beside the venue page.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'dm-vote-deals-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

// Both files destructure these at load: replaced first, so nothing is pushed.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });
pushMod.pushBadgeSync = async () => ({ skipped: true });

const authMod = require('../middleware/auth');
let CURRENT_USER = null;
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// --- the world -------------------------------------------------------------

const TAQ = 'ChIJdmVoteDealsTaq001';
const BRUNCH = 'ChIJdmVoteDealsBrunch2';
const QUIET = 'ChIJdmVoteDealsQuiet03';
const YEAR = new Date().getUTCFullYear();
const ADA = { id: 1, name: 'Ada', dob: `${YEAR - 30}-01-01` };
// Nineteen all year long: the birthday is the first of January.
const TESS = { id: 2, name: 'Tess', dob: `${YEAR - 19}-01-01` };
const NICO = { id: 3, name: 'Nico', dob: null };
const PEOPLE = [ADA, TESS, NICO];

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

const pairOf = (a, b) => [Math.min(a.id, b.id), Math.max(a.id, b.id)];

let votes;          // dm_venue_votes: { user1_id, user2_id, user_id, venue_name, venue_id }
let calls;
let dealsFail;
let birthdaysFail;
let txn = null;

// Ada voted for the taqueria and Tess for the brunch spot, in their thread.
function reset() {
  const [u1, u2] = pairOf(ADA, TESS);
  votes = [
    { user1_id: u1, user2_id: u2, user_id: ADA.id, venue_name: 'Taqueria', venue_id: TAQ },
    { user1_id: u1, user2_id: u2, user_id: TESS.id, venue_name: 'Brunch Spot', venue_id: BRUNCH },
  ];
  calls = [];
  dealsFail = false;
  birthdaysFail = false;
  txn = null;
}
reset();

// The tally statement's answer, as Postgres gives it: one row a venue name,
// its place id, the count and the voters' names, the most votes first.
function tally(u1, u2) {
  const byName = new Map();
  for (const v of votes) {
    if (v.user1_id !== Number(u1) || v.user2_id !== Number(u2)) continue;
    if (!byName.has(v.venue_name)) byName.set(v.venue_name, { venue_name: v.venue_name, venue_id: null, vote_count: 0, voters: [] });
    const g = byName.get(v.venue_name);
    if (v.venue_id && (g.venue_id === null || v.venue_id < g.venue_id)) g.venue_id = v.venue_id;
    g.vote_count += 1;
    g.voters.push(PEOPLE.find((p) => p.id === v.user_id).name);
  }
  return [...byName.values()].sort((a, b) => b.vote_count - a.vote_count);
}

async function dispatch(sql, params = []) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  calls.push({ sql: flat, params });
  const out = (rows, rowCount = rows.length) => ({ rows, rowCount });
  if (/^BEGIN/.test(flat)) { txn = votes.map((v) => ({ ...v })); return out([]); }
  if (/^ROLLBACK/.test(flat)) { if (txn) votes = txn; txn = null; return out([]); }
  if (/^COMMIT/.test(flat)) { txn = null; return out([]); }
  if (/pg_advisory_xact_lock/.test(flat)) return out([]);
  // utils/blocks.js isBlockedBetween: nobody here has blocked anybody.
  if (/^SELECT 1 FROM user_blocks WHERE/.test(flat)) return out([]);
  // routes/messages.js counterpartyIsBanned: nobody here is banned.
  if (/^SELECT 1 FROM users WHERE id = \$1 AND is_banned IS TRUE$/.test(flat)) return out([]);
  // utils/relationships.js hasDmRelationship: every pair here are friends.
  if (/^SELECT 1 WHERE EXISTS \( SELECT 1 FROM friendships/.test(flat)) return out([{ '?column?': 1 }]);
  if (/^SELECT id FROM dm_venue_votes WHERE user1_id = \$1 AND user2_id = \$2 AND user_id = \$3 AND venue_name = \$4$/.test(flat)) {
    const [u1, u2, uid, name] = params;
    return out(votes
      .filter((v) => v.user1_id === Number(u1) && v.user2_id === Number(u2) && v.user_id === Number(uid) && v.venue_name === name)
      .map((v, i) => ({ id: 100 + i })));
  }
  if (/^DELETE FROM dm_venue_votes WHERE user1_id = \$1 AND user2_id = \$2 AND user_id = \$3$/.test(flat)) {
    const [u1, u2, uid] = params.map(Number);
    const before = votes.length;
    votes = votes.filter((v) => !(v.user1_id === u1 && v.user2_id === u2 && v.user_id === uid));
    return out([], before - votes.length);
  }
  if (/^INSERT INTO dm_venue_votes \(user1_id, user2_id, user_id, venue_name, venue_id\) VALUES/.test(flat)) {
    const [u1, u2, uid, name, vid] = params;
    votes.push({ user1_id: Number(u1), user2_id: Number(u2), user_id: Number(uid), venue_name: name, venue_id: vid });
    return out([], 1);
  }
  if (/FROM dm_venue_votes vv JOIN users u ON u\.id = vv\.user_id/.test(flat)) return out(tally(params[0], params[1]));
  // utils/venueDeals.js: one venue's statement or the batch.
  if (/FROM venue_promotions p/.test(flat)) {
    if (dealsFail) throw new Error('canceling statement due to statement timeout');
    const asked = Array.isArray(params[0]) ? params[0] : [params[0]];
    const batch = Array.isArray(params[0]);
    return out(asked.flatMap((place) => (DEALS[place] || []).map((d) => (batch ? { ...d, google_place_id: place } : d))));
  }
  // utils/over21.js viewersKnownOver21: every viewer of one payload at once.
  if (/^SELECT id, date_of_birth FROM users WHERE id = ANY\(\$1::int\[\]\)$/.test(flat)) {
    if (birthdaysFail) throw new Error('connection terminated unexpectedly');
    return out(PEOPLE.filter((p) => params[0].includes(p.id)).map((p) => ({ id: p.id, date_of_birth: p.dob })));
  }
  throw new Error(`unscripted query: ${flat.slice(0, 140)}`);
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

const messagesRouter = require('../routes/messages');
const { registerHandlers, __resetRateLimiters, dmVotesFor } = require('../sockets/handlers');

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
app.use('/api', messagesRouter);
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

// One connected socket for `who`, through the real handlers.
function connect(who) {
  __resetRateLimiters();
  const sockIo = fakeIo();
  const emitted = [];
  const handlers = new Map();
  const socket = {
    id: `s-${who.name.toLowerCase()}`,
    user: { id: who.id, name: who.name },
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
  return { io: sockIo, emitted, fire: (event, data) => handlers.get(event)(data) };
}

const dealsByName = (rows) => Object.fromEntries((rows || []).map((o) => [o.venue_name, 'deal' in o ? o.deal : 'none']));
const dealReads = () => calls.filter((c) => /FROM venue_promotions p/.test(c.sql)).length;
const birthdayReads = () => calls.filter((c) => /FROM users WHERE id = ANY/.test(c.sql)).length;

// ===========================================================================
// dmVotesFor
// ===========================================================================

test('dmVotesFor: one deals statement and one birthday read for both people, each answered for themselves', async () => {
  const rows = tally(...pairOf(ADA, TESS));
  const votesOf = await dmVotesFor(rows, [TESS.id, ADA.id]);
  assert.strictEqual(dealReads(), 1);
  assert.strictEqual(birthdayReads(), 1);
  assert.deepStrictEqual(dealsByName(votesOf(ADA.id)), { Taqueria: BASKET, 'Brunch Spot': MIMOSAS });
  assert.deepStrictEqual(dealsByName(votesOf(TESS.id)), { Taqueria: CHURROS, 'Brunch Spot': 'none' }, 'the 19-year-old');
  // The tally is otherwise untouched: same order, same fields, same counts.
  for (const viewer of [ADA, TESS]) {
    assert.deepStrictEqual(votesOf(viewer.id).map(({ deal, ...row }) => row), rows, viewer.name);
  }
  // An option with no deal for that person is the row the tally read, as it was.
  assert.strictEqual(votesOf(TESS.id)[1], rows[1]);
  // Neither of two people we do not know to be 21 is sent a drink deal.
  const unknown = await dmVotesFor(rows, [TESS.id, NICO.id]);
  assert.deepStrictEqual(dealsByName(unknown(NICO.id)), { Taqueria: CHURROS, 'Brunch Spot': 'none' }, 'no date of birth');
});

test('dmVotesFor: no place id among the options asks nothing and changes nothing', async () => {
  const rows = [{ venue_name: 'Typed in', venue_id: null, vote_count: 1, voters: ['Ada'] }, { venue_name: 'Legacy', venue_id: 'abc', vote_count: 1, voters: ['Tess'] }];
  const votesOf = await dmVotesFor(rows, [ADA.id, TESS.id]);
  assert.deepStrictEqual(votesOf(ADA.id), rows);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(await dmVotesFor([], [ADA.id]).then((f) => f(ADA.id)), []);
  assert.strictEqual(calls.length, 0);
});

// ===========================================================================
// The REST tally
// ===========================================================================

test('GET /api/dm/:userId/venue-votes: each of the two reads their own deal on each option', async () => {
  const ada = await call('GET', `/api/dm/${TESS.id}/venue-votes`, ADA);
  assert.strictEqual(ada.status, 200, ada.text);
  assert.deepStrictEqual(dealsByName(ada.body.votes), { Taqueria: BASKET, 'Brunch Spot': MIMOSAS });
  const tess = await call('GET', `/api/dm/${ADA.id}/venue-votes`, TESS);
  assert.strictEqual(tess.status, 200, tess.text);
  assert.deepStrictEqual(dealsByName(tess.body.votes), { Taqueria: CHURROS, 'Brunch Spot': 'none' }, 'the 19-year-old was sent the drink deal');
  // The counts and the voters are the same tally for both.
  const shape = (rows) => rows.map(({ deal, ...row }) => row);
  assert.deepStrictEqual(shape(tess.body.votes), shape(ada.body.votes));
  // One deals read and one birthday read per answer, and only the reader's
  // own birthday is asked about.
  assert.strictEqual(dealReads(), 2);
  const asked = calls.filter((c) => /FROM users WHERE id = ANY/.test(c.sql)).map((c) => c.params[0]);
  assert.deepStrictEqual(asked, [[ADA.id], [TESS.id]]);
});

test('GET: an option with no deal carries no deal key, and a tally with none is the shape it always was', async () => {
  const [u1, u2] = pairOf(ADA, TESS);
  votes = [
    { user1_id: u1, user2_id: u2, user_id: ADA.id, venue_name: 'Quiet Cafe', venue_id: QUIET },
    { user1_id: u1, user2_id: u2, user_id: TESS.id, venue_name: 'Somewhere typed', venue_id: null },
  ];
  for (const [who, other] of [[ADA, TESS], [TESS, ADA]]) {
    const r = await call('GET', `/api/dm/${other.id}/venue-votes`, who);
    assert.strictEqual(r.status, 200, r.text);
    for (const o of r.body.votes) assert.deepStrictEqual(Object.keys(o).sort(), ['venue_id', 'venue_name', 'vote_count', 'voters'], `${who.name}: ${o.venue_name}`);
  }
  assert.strictEqual(birthdayReads(), 0, 'no drink deal among the deals, so no birthday is read');
});

test('POST /api/dm/:userId/venue-votes: the voter is answered with their own view of each option\'s deal', async () => {
  // Ada switches from the taqueria to the brunch spot.
  const ada = await call('POST', `/api/dm/${TESS.id}/venue-votes`, ADA, { venue_name: 'Brunch Spot', venue_id: BRUNCH });
  assert.strictEqual(ada.status, 200, ada.text);
  assert.deepStrictEqual(ada.body.votes.map((o) => [o.venue_name, o.vote_count]), [['Brunch Spot', 2]]);
  assert.deepStrictEqual(dealsByName(ada.body.votes), { 'Brunch Spot': MIMOSAS });
  // Tess switches to the taqueria: her answer never carries the drink deals.
  const tess = await call('POST', `/api/dm/${ADA.id}/venue-votes`, TESS, { venue_name: 'Taqueria', venue_id: TAQ });
  assert.strictEqual(tess.status, 200, tess.text);
  assert.deepStrictEqual(dealsByName(tess.body.votes), { Taqueria: CHURROS, 'Brunch Spot': 'none' });
  assert.deepStrictEqual(io.emitted, [], 'the REST vote still tells nobody else; its answer is the tally');
});

test('the un-vote: what is left is told with the voter\'s own deals, and nothing left is an empty tally', async () => {
  // The POST is a toggle, so a vote for the venue you already voted for takes it back.
  const tess = await call('POST', `/api/dm/${ADA.id}/venue-votes`, TESS, { venue_name: 'Brunch Spot', venue_id: BRUNCH });
  assert.strictEqual(tess.status, 200, tess.text);
  assert.deepStrictEqual(tess.body.votes.map((o) => o.venue_name), ['Taqueria']);
  assert.deepStrictEqual(dealsByName(tess.body.votes), { Taqueria: CHURROS });
  assert.ok(!votes.some((v) => v.user_id === TESS.id), 'the vote is taken back');
  const ada = await call('POST', `/api/dm/${TESS.id}/venue-votes`, ADA, { venue_name: 'Taqueria', venue_id: TAQ });
  assert.strictEqual(ada.status, 200, ada.text);
  assert.deepStrictEqual(ada.body.votes, []);
});

// ===========================================================================
// The socket vote
// ===========================================================================

test('dm_vote_venue: the voter and the other person are each sent their own view of each option\'s deal', async () => {
  const tess = connect(TESS);
  await tess.fire('dm_vote_venue', { receiverId: ADA.id, venue_name: 'Taqueria', venue_id: TAQ });
  const toAda = tess.emitted.find((e) => e.target === `user:${ADA.id}` && e.event === 'dm_new_vote');
  const toTess = tess.io.emitted.find((e) => e.room === `user:${TESS.id}` && e.event === 'dm_new_vote');
  assert.ok(toAda && toTess, `both are told: ${JSON.stringify([...tess.emitted, ...tess.io.emitted].map((e) => e.event))}`);
  assert.deepStrictEqual(dealsByName(toTess.payload.votes), { Taqueria: CHURROS }, 'the 19-year-old voter');
  assert.deepStrictEqual(dealsByName(toAda.payload.votes), { Taqueria: BASKET });
  // Everything else in the two copies is what it was: who voted, for what,
  // and which thread each copy belongs to.
  assert.deepStrictEqual(toAda.payload.voter, { userId: TESS.id, name: 'Tess' });
  assert.strictEqual(toAda.payload.withUserId, TESS.id);
  assert.strictEqual(toTess.payload.withUserId, ADA.id);
  assert.strictEqual(dealReads(), 1, 'one deals read for both copies');
  assert.strictEqual(birthdayReads(), 1, 'one birthday read for both people');

  // Now Ada switches to the brunch spot from her own socket.
  calls = [];
  const ada = connect(ADA);
  await ada.fire('dm_vote_venue', { receiverId: TESS.id, venue_name: 'Brunch Spot', venue_id: BRUNCH });
  const adaOwn = ada.io.emitted.find((e) => e.room === `user:${ADA.id}`);
  const tessCopy = ada.emitted.find((e) => e.target === `user:${TESS.id}`);
  assert.deepStrictEqual(dealsByName(adaOwn.payload.votes), { Taqueria: BASKET, 'Brunch Spot': MIMOSAS });
  assert.deepStrictEqual(dealsByName(tessCopy.payload.votes), { Taqueria: CHURROS, 'Brunch Spot': 'none' }, 'the drink deal the voter may see did not ride the other copy');
  assert.strictEqual(dealReads(), 1);
});

test('dm_vote_venue as an un-vote: the copies of what is left follow the same rule', async () => {
  // Ada votes again for the taqueria she already voted for, which takes it back.
  const ada = connect(ADA);
  await ada.fire('dm_vote_venue', { receiverId: TESS.id, venue_name: 'Taqueria', venue_id: TAQ });
  assert.ok(!votes.some((v) => v.user_id === ADA.id), 'the vote is taken back');
  const adaOwn = ada.io.emitted.find((e) => e.room === `user:${ADA.id}`);
  const tessCopy = ada.emitted.find((e) => e.target === `user:${TESS.id}`);
  assert.deepStrictEqual(dealsByName(adaOwn.payload.votes), { 'Brunch Spot': MIMOSAS });
  assert.deepStrictEqual(dealsByName(tessCopy.payload.votes), { 'Brunch Spot': 'none' });
});

// ===========================================================================
// Failures
// ===========================================================================

test('a deals read that fails costs the options their deals, never the vote or the tally', async () => {
  dealsFail = true;
  const g = await call('GET', `/api/dm/${TESS.id}/venue-votes`, ADA);
  assert.strictEqual(g.status, 200, g.text);
  assert.deepStrictEqual(g.body.votes.map((o) => o.venue_name), ['Taqueria', 'Brunch Spot']);
  assert.ok(g.body.votes.every((o) => !('deal' in o)));

  const p = await call('POST', `/api/dm/${TESS.id}/venue-votes`, ADA, { venue_name: 'Brunch Spot', venue_id: BRUNCH });
  assert.strictEqual(p.status, 200, p.text);
  assert.deepStrictEqual(p.body.votes.map((o) => [o.venue_name, o.vote_count]), [['Brunch Spot', 2]]);
  assert.ok(p.body.votes.every((o) => !('deal' in o)));
  assert.strictEqual(votes.find((v) => v.user_id === ADA.id).venue_name, 'Brunch Spot', 'the vote is stored');

  const tess = connect(TESS);
  await tess.fire('dm_vote_venue', { receiverId: ADA.id, venue_name: 'Taqueria', venue_id: TAQ });
  const copies = [...tess.emitted, ...tess.io.emitted].filter((e) => e.event === 'dm_new_vote');
  assert.strictEqual(copies.length, 2, 'both people are still told');
  for (const e of copies) {
    assert.deepStrictEqual(e.payload.votes.map((o) => o.venue_name).sort(), ['Brunch Spot', 'Taqueria']);
    assert.ok(e.payload.votes.every((o) => !('deal' in o)), e.target || e.room);
  }
  assert.strictEqual(votes.find((v) => v.user_id === TESS.id).venue_name, 'Taqueria', 'the socket vote is stored');
});

test('a birthday read that fails sends nobody a drink deal, the food deal still shows and the vote still lands', async () => {
  birthdaysFail = true;
  const g = await call('GET', `/api/dm/${TESS.id}/venue-votes`, ADA);
  assert.strictEqual(g.status, 200, g.text);
  assert.deepStrictEqual(dealsByName(g.body.votes), { Taqueria: CHURROS, 'Brunch Spot': 'none' });

  const ada = connect(ADA);
  await ada.fire('dm_vote_venue', { receiverId: TESS.id, venue_name: 'Brunch Spot', venue_id: BRUNCH });
  const copies = [...ada.emitted, ...ada.io.emitted].filter((e) => e.event === 'dm_new_vote');
  assert.strictEqual(copies.length, 2);
  for (const e of copies) assert.deepStrictEqual(dealsByName(e.payload.votes), { 'Brunch Spot': 'none' }, e.target || e.room);
});
