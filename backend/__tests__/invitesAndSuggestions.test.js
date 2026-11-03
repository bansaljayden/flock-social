'use strict';
// Run: node --test __tests__/invitesAndSuggestions.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// WHO CAN ADD AN ACCOUNT TO A PLAN, AND WHO FLOCK SUGGESTS IT TO
// ---------------------------------------------------------------------------
//
// Migration 133 gives an account two choices, under "Invites and Quick Add":
// plan invites from everyone or from friends only, and whether Flock may
// suggest it to people who are not its friends. A choice never made follows
// the account's age: friends only and not suggested when the stored date of
// birth makes it under 18, and exactly today's behaviour otherwise. This runs
// every rule against a real, migrated Postgres, through the real routes and
// the real socket handler, because each rule is a predicate inside a
// statement and only a database can say which rows it keeps.
//
//   1. JavaScript and SQL agree on who is under 18, on every boundary,
//      including the leap days and the year-end dates the website stores.
//   2. GET and PUT /api/users/me/privacy: the answer that applies, the age
//      defaults, one field at a time, and nothing but the exact values.
//   3. The invite doors (create, invite, rerun) and the socket relay refuse a
//      stranger and let a friend through, and a refusal reads exactly like
//      an id nobody holds.
//   4. Quick Add and the Suggested rows leave out an account that is not to
//      be suggested, to everyone but its friends.
//   5. The migration and the data export.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

// Synchronous and before config/database is required anywhere: that module
// builds its Pool from DATABASE_URL at require time. Everything that touches
// the database is required inside test.before() so it binds to this one.
const PG_PORT = pickEmbeddedPgPort('invitesAndSuggestions');
const DB_NAME = 'flock_invites_and_suggestions';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
process.env.PGSSLMODE = 'disable';
process.env.JWT_SECRET = 'test-secret-for-invites-and-suggestions';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const ROOT = path.join(__dirname, '..');
const reach = require('../utils/invitesAndSuggestions');

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let handlers;
let flocksRouter;
let seq = 0;

function call(method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(base + url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, text: raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// A calendar date `years` before today's UTC date, as YYYY-MM-DD. February 29
// becomes February 28 in a year that has none, which only makes the person a
// day older; every age used below is years away from a boundary.
function yearsAgo(years) {
  const now = new Date();
  const y = now.getUTCFullYear() - years;
  const m = now.getUTCMonth() + 1;
  let d = now.getUTCDate();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (m === 2 && d === 29 && !leap) d = 28;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function mkUser(name, { dob = null, friendsOnly = null, suggested = null } = {}) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, date_of_birth, invites_friends_only, show_in_suggestions)
     VALUES ($1, 'x', $2, true, $3::date, $4::boolean, $5::boolean) RETURNING *`,
    [`u${seq}-${Date.now()}@reach.test`, name, dob, friendsOnly, suggested]
  );
  return { ...rows[0], token: signUserToken(rows[0]) };
}

const teen = (name, opts = {}) => mkUser(name, { dob: yearsAgo(15), ...opts });
const adult = (name, opts = {}) => mkUser(name, { dob: yearsAgo(30), ...opts });

async function befriend(a, b) {
  await pool.query(
    "INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')",
    [a.id, b.id]
  );
}

async function mkFlock(creator, { status = 'planning' } = {}) {
  const { rows } = await pool.query(
    "INSERT INTO flocks (name, creator_id, status) VALUES ('Friday', $1, $2) RETURNING id",
    [creator.id, status]
  );
  await addMember(rows[0].id, creator, 'accepted');
  return rows[0].id;
}

async function addMember(flockId, user, status) {
  await pool.query(
    'INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, $3)',
    [flockId, user.id, status]
  );
}

const membershipOf = async (flockId, user) => (await pool.query(
  'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
  [flockId, user.id]
)).rows[0]?.status ?? null;

const invitedIds = (res) => (res.body.invited || []).map((i) => i.user_id).sort((x, y) => x - y);

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-invites-suggestions-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'invitesAndSuggestions', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  ({ signUserToken } = require('../middleware/auth'));
  handlers = require('../sockets/handlers');
  flocksRouter = require('../routes/flocks');

  const app = express();
  app.use(express.json());
  app.use('/api/flocks', flocksRouter);
  app.use('/api/friends', require('../routes/friends'));
  app.use('/api/users', require('../routes/users'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => (server ? server.close(r) : r()));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn('[invitesAndSuggestions] could not remove %s: %s', dataDir, err.message);
  }
});

test.beforeEach(() => {
  flocksRouter.__resetBudgets();
  handlers.__resetRateLimiters();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Who is under 18, asked in JavaScript and in SQL
// ═══════════════════════════════════════════════════════════════════════════

test('JavaScript and SQL agree on who is under 18, on every boundary', async () => {
  const todays = ['2026-02-28', '2026-03-01', '2028-02-29', '2028-03-01', '2026-11-02', '2026-12-31', '2027-01-01'];
  const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const cases = [];
  for (const today of todays) {
    const [ty, tm, td] = today.split('-').map(Number);
    const y = ty - 18;
    // The day 18 years back, and the days either side of it. A 29 February
    // has none in most years, and 28 February stands in for it.
    const probe = new Date(Date.UTC(y, tm - 1, td));
    const exact = probe.getUTCMonth() === tm - 1 ? iso(y, tm, td) : iso(y, 2, 28);
    for (const dob of [shift(exact, -1), exact, shift(exact, 1), iso(y, 2, 28), iso(y, 3, 1), iso(y, 12, 31),
      '2008-02-29', '2010-02-28', '2010-03-01', '2008-12-31', '2009-01-01', '1990-06-15', '2014-06-15', null]) {
      cases.push({ today, dob });
    }
  }
  const sql = `SELECT ${reach.knownMinorSql('u', { asOf: '$2::date' })} AS minor FROM (SELECT $1::date AS date_of_birth) u`;
  const disagreements = [];
  for (const { today, dob } of cases) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query(sql, [dob, today]);
    const js = reach.knownMinor(dob, today);
    if (rows[0].minor !== js) disagreements.push(`${dob} on ${today}: SQL ${rows[0].minor}, JS ${js}`);
    assert.strictEqual(typeof rows[0].minor, 'boolean', 'the SQL answer is never NULL');
  }
  assert.deepStrictEqual(disagreements, []);
  assert.ok(cases.length > 90, 'the matrix ran');

  // And the plain cases read as they should.
  assert.strictEqual(reach.knownMinor('2008-02-29', '2026-02-28'), true, 'a leap-day birthday is 18 on 1 March');
  assert.strictEqual(reach.knownMinor('2008-02-29', '2026-03-01'), false);
  assert.strictEqual(reach.knownMinor(null), false, 'no date of birth is not a minor');
  assert.strictEqual(reach.knownMinor('2008-12-31', '2026-12-30'), true, 'the year-end date the website stores errs younger');
});

test('the effective settings are the account\'s choice, else the default for its age', () => {
  const today = '2026-11-02';
  const minorDob = '2011-05-05';
  const adultDob = '1995-05-05';
  const eff = (row) => reach.effectiveSettings(row, today);
  assert.deepStrictEqual(eff({ date_of_birth: minorDob }), { invitesFrom: 'friends', showInSuggestions: false });
  assert.deepStrictEqual(eff({ date_of_birth: adultDob }), { invitesFrom: 'everyone', showInSuggestions: true });
  assert.deepStrictEqual(eff({ date_of_birth: null }), { invitesFrom: 'everyone', showInSuggestions: true },
    'no date of birth (the iPhone app asks for none) keeps today\'s behaviour');
  assert.deepStrictEqual(eff({ date_of_birth: minorDob, invites_friends_only: false, show_in_suggestions: true }),
    { invitesFrom: 'everyone', showInSuggestions: true }, 'a minor\'s own choice stands');
  assert.deepStrictEqual(eff({ date_of_birth: adultDob, invites_friends_only: true, show_in_suggestions: false }),
    { invitesFrom: 'friends', showInSuggestions: false }, 'an adult\'s own choice stands');
  assert.deepStrictEqual(eff({ date_of_birth: minorDob, invites_friends_only: false }),
    { invitesFrom: 'everyone', showInSuggestions: false }, 'one choice made leaves the other at its default');
});

test('the SQL builders take route constants only', () => {
  assert.throws(() => reach.acceptsInvitesFromSql('users; DROP TABLE users', '$2'));
  assert.throws(() => reach.acceptsInvitesFromSql('users', '1 OR 1=1'));
  assert.throws(() => reach.suggestableToSql('u', '$1', { asOf: "now() - '1 day'" }));
  assert.match(reach.acceptsInvitesFromSql('users', '$2'), /^\(COALESCE\(users\.invites_friends_only, /);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. GET and PUT /api/users/me/privacy
// ═══════════════════════════════════════════════════════════════════════════

test('the switches read what applies: friends only and not suggested under 18, as before for everyone else', async () => {
  const minor = await teen('Mina');
  const grown = await adult('Gus');
  const unknown = await mkUser('Nadia'); // no date of birth, as every iPhone signup
  for (const [who, expected] of [
    [minor, { invitesFrom: 'friends', showInSuggestions: false }],
    [grown, { invitesFrom: 'everyone', showInSuggestions: true }],
    [unknown, { invitesFrom: 'everyone', showInSuggestions: true }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call('GET', '/api/users/me/privacy', { token: who.token });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, expected, who.name);
  }
});

test('a write changes the one field it names, and the answer is the row\'s', async () => {
  const minor = await teen('Rory');
  let res = await call('PUT', '/api/users/me/privacy', { token: minor.token, body: { invitesFrom: 'everyone' } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { invitesFrom: 'everyone', showInSuggestions: false });
  let row = (await pool.query('SELECT invites_friends_only, show_in_suggestions FROM users WHERE id = $1', [minor.id])).rows[0];
  assert.deepStrictEqual(row, { invites_friends_only: false, show_in_suggestions: null },
    'the field that was not sent keeps following the age default');

  res = await call('PUT', '/api/users/me/privacy', { token: minor.token, body: { showInSuggestions: true } });
  assert.deepStrictEqual(res.body, { invitesFrom: 'everyone', showInSuggestions: true });
  res = await call('PUT', '/api/users/me/privacy', { token: minor.token, body: { invitesFrom: 'friends', showInSuggestions: false } });
  assert.deepStrictEqual(res.body, { invitesFrom: 'friends', showInSuggestions: false });
  row = (await pool.query('SELECT invites_friends_only, show_in_suggestions FROM users WHERE id = $1', [minor.id])).rows[0];
  assert.deepStrictEqual(row, { invites_friends_only: true, show_in_suggestions: false });
  assert.deepStrictEqual((await call('GET', '/api/users/me/privacy', { token: minor.token })).body,
    { invitesFrom: 'friends', showInSuggestions: false });
});

test('anything but the exact values is refused, with nothing written', async () => {
  const grown = await adult('Ivo');
  const refused = [
    {},
    { invitesFrom: 'Friends' },
    { invitesFrom: 'nobody' },
    { invitesFrom: ['friends'] },
    { invitesFrom: null },
    { showInSuggestions: 'false' },
    { showInSuggestions: 0 },
    { showInSuggestions: null },
    { showInSuggestions: [false] },
    { invitesFrom: 'friends', showInSuggestions: 'no' },
  ];
  for (const body of refused) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call('PUT', '/api/users/me/privacy', { token: grown.token, body });
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} was accepted`);
    assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
  }
  const row = (await pool.query('SELECT invites_friends_only, show_in_suggestions FROM users WHERE id = $1', [grown.id])).rows[0];
  assert.deepStrictEqual(row, { invites_friends_only: null, show_in_suggestions: null });
});

test('neither half answers without a session', async () => {
  assert.strictEqual((await call('GET', '/api/users/me/privacy')).status, 401);
  assert.strictEqual((await call('PUT', '/api/users/me/privacy', { body: { invitesFrom: 'friends' } })).status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The invite doors
// ═══════════════════════════════════════════════════════════════════════════

test('POST /:id/invite: a stranger cannot add a teen, a friend can, and the refusal reads like nobody', async () => {
  const host = await adult('Host');
  const friend = await adult('Pal');
  const kid = await teen('Kid');
  await befriend(kid, friend);
  const flockId = await mkFlock(host);
  await addMember(flockId, friend, 'accepted');

  // The answer for an id nobody holds, to compare the refusal with.
  const nobody = await call('POST', `/api/flocks/${flockId}/invite`, { token: host.token, body: { user_ids: [2147480000] } });
  assert.strictEqual(nobody.status, 200, nobody.text);

  const refused = await call('POST', `/api/flocks/${flockId}/invite`, { token: host.token, body: { user_ids: [kid.id] } });
  assert.strictEqual(refused.status, 200, refused.text);
  assert.deepStrictEqual(invitedIds(refused), []);
  assert.strictEqual(refused.text, nobody.text, 'a refused invite answers exactly as an id with no account does');
  assert.strictEqual(await membershipOf(flockId, kid), null, 'and writes nothing');

  // A friend on the same plan adds them, which is what the setting allows.
  const allowed = await call('POST', `/api/flocks/${flockId}/invite`, { token: friend.token, body: { user_ids: [kid.id] } });
  assert.strictEqual(allowed.status, 200, allowed.text);
  assert.deepStrictEqual(invitedIds(allowed), [kid.id]);
  assert.strictEqual(await membershipOf(flockId, kid), 'invited');
});

test('POST /:id/invite: an adult with no choice made is invited by anyone, as before', async () => {
  const host = await adult('Host2');
  const grown = await adult('Grown');
  const unknown = await mkUser('NoDob');
  const flockId = await mkFlock(host);
  const res = await call('POST', `/api/flocks/${flockId}/invite`, { token: host.token, body: { user_ids: [grown.id, unknown.id] } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(invitedIds(res), [grown.id, unknown.id].sort((x, y) => x - y));
});

test('POST /:id/invite: the choice beats the default, either way round', async () => {
  const host = await adult('Host3');
  const strictAdult = await adult('Strict', { friendsOnly: true });
  const openTeen = await teen('Open', { friendsOnly: false });
  const flockId = await mkFlock(host);
  const res = await call('POST', `/api/flocks/${flockId}/invite`, { token: host.token, body: { user_ids: [strictAdult.id, openTeen.id] } });
  assert.deepStrictEqual(invitedIds(res), [openTeen.id]);
  assert.strictEqual(await membershipOf(flockId, strictAdult), null);
});

test('POST /:id/invite: a stranger cannot re-invite a teen who declined, and the decline stands', async () => {
  const host = await adult('Host4');
  const kid = await teen('Kid4');
  const flockId = await mkFlock(host);
  await addMember(flockId, kid, 'declined');
  const res = await call('POST', `/api/flocks/${flockId}/invite`, { token: host.token, body: { user_ids: [kid.id] } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(invitedIds(res), []);
  assert.strictEqual(await membershipOf(flockId, kid), 'declined');
});

test('POST /api/flocks: a new plan seats only the invitees who take invites from its maker', async () => {
  const maker = await adult('Maker');
  const kid = await teen('Kid5');
  const grown = await adult('Grown5');
  const res = await call('POST', '/api/flocks', { token: maker.token, body: { name: 'Friday plan', invited_user_ids: [kid.id, grown.id] } });
  assert.strictEqual(res.status, 201, res.text);
  assert.deepStrictEqual(res.body.invited_user_ids, [grown.id], 'the echo names who actually got a row');
  assert.strictEqual(await membershipOf(res.body.flock.id, kid), null);
  assert.strictEqual(await membershipOf(res.body.flock.id, grown), 'invited');

  // The kid's friend makes a plan with them in it.
  await befriend(maker, kid);
  const again = await call('POST', '/api/flocks', { token: maker.token, body: { name: 'Saturday plan', invited_user_ids: [kid.id] } });
  assert.strictEqual(again.status, 201, again.text);
  assert.deepStrictEqual(again.body.invited_user_ids, [kid.id]);
});

test('POST /:id/rerun: running a plan again re-invites only the people who take invites from the rerunner', async () => {
  const runner = await adult('Runner');
  const kid = await teen('Kid6');
  const grown = await adult('Grown6');
  const source = await mkFlock(runner, { status: 'completed' });
  await addMember(source, kid, 'accepted');
  await addMember(source, grown, 'accepted');

  const res = await call('POST', `/api/flocks/${source}/rerun`, { token: runner.token, body: {} });
  assert.strictEqual(res.status, 201, res.text);
  assert.deepStrictEqual(res.body.invited_user_ids, [grown.id]);
  assert.strictEqual(await membershipOf(res.body.flock.id, kid), null);

  await befriend(kid, runner);
  const again = await call('POST', `/api/flocks/${source}/rerun`, { token: runner.token, body: {} });
  assert.strictEqual(again.status, 201, again.text);
  assert.deepStrictEqual([...again.body.invited_user_ids].sort((x, y) => x - y), [kid.id, grown.id].sort((x, y) => x - y));
});

// The socket relay: the toast names its sender as the inviter, so an account
// that takes invites from friends only hears it from a friend only.
function fakeIo() {
  const emitted = [];
  return {
    emitted,
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
    to(room) {
      return {
        except() { return this; },
        emit(event, payload) { emitted.push({ room, event, payload }); },
      };
    },
  };
}

function fakeSocket(id, user) {
  const on = new Map();
  const socket = {
    id,
    user,
    rooms: new Set(),
    handshake: null,
    on(event, handler) { on.set(event, handler); },
    join(room) { socket.rooms.add(room); },
    leave(room) { socket.rooms.delete(room); },
    emit() {},
    to() { return { except() { return this; }, emit() {} }; },
    disconnect() {},
    handlers: on,
  };
  return socket;
}

test('the flock_invite relay reaches a teen from a friend, and never from a stranger', async () => {
  const host = await adult('Host7');
  const friend = await adult('Pal7');
  const kid = await teen('Kid7');
  await befriend(friend, kid);
  const flockId = await mkFlock(host);
  await addMember(flockId, friend, 'accepted');
  await addMember(flockId, kid, 'invited'); // the friend's invite, already written

  const relay = async (sender) => {
    const io = fakeIo();
    const s = fakeSocket(`sock-${sender.id}`, { id: sender.id, name: sender.name });
    handlers.registerHandlers(io, s);
    await s.handlers.get('flock_invite')({ flockId, invitedUserIds: [kid.id] });
    return io.emitted.filter((e) => e.event === 'flock_invite_received' && e.room === `user:${kid.id}`);
  };

  assert.strictEqual((await relay(host)).length, 0, 'a stranger relayed an invite toast naming themselves');
  const fromFriend = await relay(friend);
  assert.strictEqual(fromFriend.length, 1);
  assert.strictEqual(fromFriend[0].payload.invitedBy.userId, friend.id);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Quick Add and the Suggested rows
// ═══════════════════════════════════════════════════════════════════════════

test('Quick Add leaves out a teen and anyone who turned it off, and keeps everyone else', async () => {
  const viewer = await adult('Viewer');
  const bridge = await adult('Bridge');
  const kid = await teen('Kid8');
  const grown = await adult('Grown8');
  const unknown = await mkUser('NoDob8');
  const hidden = await adult('Hidden8', { suggested: false });
  const openTeen = await teen('OpenTeen8', { suggested: true });
  await befriend(viewer, bridge);
  for (const u of [kid, grown, unknown, hidden, openTeen]) {
    // eslint-disable-next-line no-await-in-loop
    await befriend(bridge, u);
  }
  const res = await call('GET', '/api/friends/suggestions', { token: viewer.token });
  assert.strictEqual(res.status, 200, res.text);
  const ids = res.body.suggestions.map((s) => s.id).sort((x, y) => x - y);
  assert.deepStrictEqual(ids, [grown.id, unknown.id, openTeen.id].sort((x, y) => x - y));
});

test('the Suggested row keeps a hidden flock mate for their friends only', async () => {
  const viewer = await adult('Viewer9');
  const kid = await teen('Kid9');
  const grown = await adult('Grown9');
  const hidden = await adult('Hidden9', { suggested: false });
  const hiddenFriend = await adult('HiddenFriend9', { suggested: false });
  await befriend(viewer, hiddenFriend);
  const flockId = await mkFlock(viewer, { status: 'completed' });
  for (const u of [kid, grown, hidden, hiddenFriend]) {
    // eslint-disable-next-line no-await-in-loop
    await addMember(flockId, u, 'accepted');
  }
  const res = await call('GET', '/api/users/suggested', { token: viewer.token });
  assert.strictEqual(res.status, 200, res.text);
  const ids = res.body.users.map((u) => u.id).sort((x, y) => x - y);
  assert.deepStrictEqual(ids, [grown.id, hiddenFriend.id].sort((x, y) => x - y),
    'a friend still sees a friend who turned suggestions off; nobody else sees them or the teen');
});

test('existing friendships, requests and searches are untouched by either switch', async () => {
  const kid = await teen('Kid10');
  const pal = await adult('Pal10');
  await befriend(kid, pal);
  const friends = await call('GET', '/api/friends', { token: kid.token });
  assert.deepStrictEqual(friends.body.friends.map((f) => f.id), [pal.id]);
  // A stranger can still find the teen by name and ask to be friends; the
  // switches are about plans and suggestions, not about being findable.
  const stranger = await adult('Stranger10');
  const found = await call('GET', `/api/users/search?q=${encodeURIComponent('Kid10')}`, { token: stranger.token });
  assert.ok(found.body.users.some((u) => u.id === kid.id));
  const asked = await call('POST', '/api/friends/request', { token: stranger.token, body: { user_id: kid.id } });
  assert.strictEqual(asked.status, 200, asked.text);
  assert.strictEqual(asked.body.status, 'pending');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The migration and the export
// ═══════════════════════════════════════════════════════════════════════════

test('migration 133 adds both columns the way the runner and the replay suite expect', async () => {
  const dir = path.join(ROOT, 'migrations');
  const sql = fs.readFileSync(path.join(dir, '133_invites_and_suggestions.sql'), 'utf8');
  assert.match(sql, /^ALTER TABLE users ADD COLUMN IF NOT EXISTS invites_friends_only BOOLEAN;$/m);
  assert.match(sql, /^ALTER TABLE users ADD COLUMN IF NOT EXISTS show_in_suggestions BOOLEAN;$/m);
  assert.match(sql, /^-- @requires column users\.invites_friends_only$/m);
  assert.match(sql, /^-- @requires column users\.show_in_suggestions$/m);
  assert.ok(/^[\x00-\x7F]*$/.test(sql), 'the migration is ASCII only (the replay suite runs WIN1252)');
  const numbered = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && f.startsWith('133_'));
  assert.deepStrictEqual(numbered, ['133_invites_and_suggestions.sql'], 'one file numbered 133');
  // Nullable with no default: NULL is "never chosen" and must stay that way.
  const { rows } = await pool.query(
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'users' AND column_name IN ('invites_friends_only', 'show_in_suggestions')
      ORDER BY column_name`
  );
  assert.deepStrictEqual(rows, [
    { column_name: 'invites_friends_only', is_nullable: 'YES', column_default: null },
    { column_name: 'show_in_suggestions', is_nullable: 'YES', column_default: null },
  ]);
});

test('the data export selects both choices and publishes them', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'users.js'), 'utf8');
  const exportSelect = src.match(/router\.get\('\/export'[\s\S]*?`(SELECT id, email, name[\s\S]*?FROM users WHERE id = \$1)`/);
  assert.ok(exportSelect, "could not find the export's SELECT in routes/users.js");
  assert.match(exportSelect[1], /\binvites_friends_only\b/);
  assert.match(exportSelect[1], /\bshow_in_suggestions\b/);
  assert.match(src, /invites_friends_only: account\.invites_friends_only \?\? null,/);
  assert.match(src, /show_in_suggestions: account\.show_in_suggestions \?\? null,/);
});
