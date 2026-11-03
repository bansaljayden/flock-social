'use strict';
// Run: node --test __tests__/invitesAndSuggestions.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// WHO CAN ADD AN ACCOUNT TO A PLAN, AND WHO FLOCK SUGGESTS IT TO
// ---------------------------------------------------------------------------
//
// Migration 133 gives an account two choices, under "Invites and Quick Add":
// plan invites from everyone or from friends only, and whether Flock may
// suggest it to people who are not its friends. Both are opt-in: an account
// that never chose keeps exactly today's behaviour, whatever its date of
// birth. Age-based defaults (under 18: friends only and not suggested) are
// kept in utils/invitesAndSuggestions.js behind MINOR_SAFER_DEFAULTS, which
// ships off. Section 6 compiles a private copy of that file with the constant
// on and runs the age defaults against the same database, so they stay proven
// for the day it is turned on; the module the routes hold is never touched.
//
// Every rule runs against a real, migrated Postgres, through the real routes
// and the real socket handler, because each rule is a predicate inside a
// statement and only a database can say which rows it keeps.
//
//   1. The rule in JavaScript and in SQL: the constant ships off, the two
//      agree on who is under 18 on every boundary and on the settings that
//      apply with the constant off and on, and nothing reads a date of birth
//      while it is off.
//   2. GET and PUT /api/users/me/privacy: the answer that applies, one field
//      at a time, and nothing but the exact values.
//   3. The invite doors (create, invite, rerun) and the socket relay: a teen
//      who never chose is invited exactly like an adult; an account that
//      chose friends only, teen or adult, is refused to a stranger and reached
//      by a friend; and a refusal reads exactly like an id nobody holds.
//   4. Quick Add and the Suggested rows: a teen who never chose is suggested
//      like anyone else; an account that turned it off is left out for
//      everyone but its friends.
//   5. The migration and the data export.
//   6. The age defaults, with MINOR_SAFER_DEFAULTS on.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
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

// utils/invitesAndSuggestions.js as it would run with MINOR_SAFER_DEFAULTS set
// to `on`: the file's own source, compiled privately with that one line
// changed, its require bound to the file's own directory. The module the
// routes hold (the one in require.cache) is never touched, so the switched-on
// copy cannot leak into another test or into a route.
const REACH_FILE = require.resolve('../utils/invitesAndSuggestions');
const CONSTANT_LINE = /^const MINOR_SAFER_DEFAULTS = (?:true|false);$/m;
function reachWith(on) {
  const src = fs.readFileSync(REACH_FILE, 'utf8');
  assert.match(src, CONSTANT_LINE, 'MINOR_SAFER_DEFAULTS is declared on one line, as true or false');
  const copy = { exports: {} };
  const body = src.replace(CONSTANT_LINE, `const MINOR_SAFER_DEFAULTS = ${on};`);
  vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${body}\n})`, { filename: REACH_FILE })
    .call(copy.exports, copy.exports, createRequire(REACH_FILE), copy, REACH_FILE, path.dirname(REACH_FILE));
  assert.strictEqual(copy.exports.MINOR_SAFER_DEFAULTS, on);
  return copy.exports;
}

// What an account that never chose reads as, today, at any age.
const OPEN = { invitesFrom: 'everyone', showInSuggestions: true };
// What a teen who never chose would read as with the age defaults on, and
// what anyone reads as after choosing both.
const CLOSED = { invitesFrom: 'friends', showInSuggestions: false };

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

const byId = (x, y) => x - y;
const ids = (...users) => users.map((u) => u.id).sort(byId);
const invitedIds = (res) => (res.body.invited || []).map((i) => i.user_id).sort(byId);

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
// 1. The rule, asked in JavaScript and in SQL
// ═══════════════════════════════════════════════════════════════════════════

test('the age defaults ship off', () => {
  assert.strictEqual(reach.MINOR_SAFER_DEFAULTS, false,
    'Turning MINOR_SAFER_DEFAULTS on needs the privacy policy sentence changed first (the date of birth is used '
    + '"for nothing else") and a decision on what a refusal would tell a stranger about age. The comment above '
    + 'the constant in utils/invitesAndSuggestions.js says both; sections 2 to 4 below assert the shipped behaviour.');
});

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

test('JavaScript and SQL agree on the settings that apply, with the age defaults off and on', async () => {
  const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const choices = [null, true, false];
  const disagreements = [];
  let compared = 0;
  for (const on of [false, true]) {
    const r = reachWith(on);
    // effectiveSettings on one side; on the other, the two fragments every
    // door and read is built from, over the same rows, on the same day. The
    // day is selected as well because, switched off, neither fragment asks
    // for it.
    const sql = `SELECT u.i, $5::date AS today,
                        ${r.invitesFriendsOnlySql('u', { asOf: '$5::date' })} AS friends_only,
                        ${r.showInSuggestionsSql('u', { asOf: '$5::date' })} AS suggested
                   FROM unnest($1::int[], $2::date[], $3::boolean[], $4::boolean[])
                        AS u(i, date_of_birth, invites_friends_only, show_in_suggestions)`;
    for (const today of ['2026-02-28', '2028-02-29', '2026-11-02']) {
      const [ty, tm, td] = today.split('-').map(Number);
      const y = ty - 18;
      const probe = new Date(Date.UTC(y, tm - 1, td));
      const exact = probe.getUTCMonth() === tm - 1 ? iso(y, tm, td) : iso(y, 2, 28);
      const rows = [];
      for (const dob of [shift(exact, -1), exact, shift(exact, 1), '1990-06-15', '2014-06-15', null]) {
        for (const friendsOnly of choices) {
          for (const suggested of choices) rows.push({ dob, friendsOnly, suggested });
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const out = await pool.query(sql, [
        rows.map((_, i) => i), rows.map((x) => x.dob), rows.map((x) => x.friendsOnly), rows.map((x) => x.suggested), today,
      ]);
      assert.strictEqual(out.rows.length, rows.length);
      for (const o of out.rows) {
        const x = rows[o.i];
        assert.strictEqual(typeof o.friends_only, 'boolean', 'the SQL answer is never NULL');
        assert.strictEqual(typeof o.suggested, 'boolean', 'the SQL answer is never NULL');
        const fromSql = { invitesFrom: o.friends_only ? 'friends' : 'everyone', showInSuggestions: o.suggested };
        const fromJs = r.effectiveSettings({ date_of_birth: x.dob, invites_friends_only: x.friendsOnly, show_in_suggestions: x.suggested }, today);
        if (JSON.stringify(fromSql) !== JSON.stringify(fromJs)) {
          disagreements.push(`${on ? 'on' : 'off'}, ${JSON.stringify(x)} on ${today}: SQL ${JSON.stringify(fromSql)}, JS ${JSON.stringify(fromJs)}`);
        }
        compared += 1;
      }
    }
  }
  assert.deepStrictEqual(disagreements, []);
  assert.strictEqual(compared, 2 * 3 * 6 * 9, 'the matrix ran, both ways round');
});

test('the settings that apply are the account\'s choice, else today\'s behaviour, whatever its age', () => {
  const today = '2026-11-02';
  const minorDob = '2011-05-05';
  const adultDob = '1995-05-05';
  const eff = (row) => reach.effectiveSettings(row, today);
  assert.deepStrictEqual(eff({ date_of_birth: minorDob }), OPEN, 'a teen who never chose reads exactly like an adult');
  assert.deepStrictEqual(eff({ date_of_birth: adultDob }), OPEN);
  assert.deepStrictEqual(eff({ date_of_birth: null }), OPEN, 'no date of birth (the iPhone app asks for none)');
  assert.deepStrictEqual(eff(null), OPEN);
  assert.deepStrictEqual(eff({ date_of_birth: minorDob, invites_friends_only: true, show_in_suggestions: false }),
    CLOSED, 'a teen\'s own choice stands');
  assert.deepStrictEqual(eff({ date_of_birth: adultDob, invites_friends_only: true, show_in_suggestions: false }),
    CLOSED, 'an adult\'s own choice stands');
  assert.deepStrictEqual(eff({ date_of_birth: minorDob, invites_friends_only: false, show_in_suggestions: true }), OPEN);
  assert.deepStrictEqual(eff({ date_of_birth: minorDob, invites_friends_only: true }),
    { invitesFrom: 'friends', showInSuggestions: true }, 'one choice made leaves the other as it always was');
  assert.deepStrictEqual(eff({ date_of_birth: minorDob, show_in_suggestions: false }),
    { invitesFrom: 'everyone', showInSuggestions: false });
});

test('while the age defaults are off, no rule reads a date of birth', () => {
  for (const fragment of [
    reach.invitesFriendsOnlySql('u'),
    reach.showInSuggestionsSql('u'),
    reach.acceptsInvitesFromSql('users', '$2'),
    reach.acceptsInvitesFromSql('iu', '$3'),
    reach.suggestableToSql('u', '$1'),
  ]) {
    assert.doesNotMatch(fragment, /date_of_birth/, fragment);
  }
  // effectiveSettings does not even look: a row whose date of birth cannot be
  // read answers like any other.
  const unreadable = { get date_of_birth() { throw new Error('the date of birth was read'); } };
  assert.deepStrictEqual(reach.effectiveSettings(unreadable), OPEN);
  const choseFriendsOnly = { invites_friends_only: true, get date_of_birth() { throw new Error('the date of birth was read'); } };
  assert.deepStrictEqual(reach.effectiveSettings(choseFriendsOnly), { invitesFrom: 'friends', showInSuggestions: true });

  // Switched on, the same builders read it, which is what section 6 runs.
  const on = reachWith(true);
  assert.match(on.acceptsInvitesFromSql('users', '$2'), /users\.date_of_birth/);
  assert.match(on.suggestableToSql('u', '$1'), /u\.date_of_birth/);
  assert.throws(() => on.effectiveSettings(unreadable), /the date of birth was read/);
});

test('the copy section 6 compiles is this module: built with the shipped value, it writes the same SQL', () => {
  const same = reachWith(reach.MINOR_SAFER_DEFAULTS);
  assert.deepStrictEqual(Object.keys(same), Object.keys(reach));
  for (const [name, args] of [
    ['acceptsInvitesFromSql', ['users', '$2']],
    ['acceptsInvitesFromSql', ['iu', '$3']],
    ['suggestableToSql', ['u', '$1']],
    ['invitesFriendsOnlySql', ['u', { asOf: '$4::date' }]],
    ['showInSuggestionsSql', ['u']],
  ]) {
    assert.strictEqual(same[name](...args), reach[name](...args), name);
  }
  // And every door builds its rule from this module with these arguments, and
  // asks no age question of its own, so the constant is the only switch.
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const [file, built] of [
    ['routes/flocks.js', "acceptsInvitesFromSql('users', '$2')"],
    ['sockets/handlers.js', "acceptsInvitesFromSql('iu', '$3')"],
    ['routes/friends.js', "suggestableToSql('u', '$1')"],
    ['routes/users.js', "suggestableToSql('u', '$1')"],
  ]) {
    const src = read(file);
    assert.ok(src.includes(built), `${file} builds ${built}`);
    assert.doesNotMatch(src, /knownMinor/, `${file} asks no age question of its own`);
  }
});

test('the SQL builders take route constants only', () => {
  for (const r of [reach, reachWith(true)]) {
    assert.throws(() => r.acceptsInvitesFromSql('users; DROP TABLE users', '$2'));
    assert.throws(() => r.acceptsInvitesFromSql('users', '1 OR 1=1'));
    assert.throws(() => r.suggestableToSql('u', '$1', { asOf: "now() - '1 day'" }));
    assert.throws(() => r.invitesFriendsOnlySql('u', { asOf: '$1' }));
  }
  assert.match(reach.acceptsInvitesFromSql('users', '$2'), /^\(COALESCE\(users\.invites_friends_only, FALSE\) IS NOT TRUE OR /);
  assert.match(reach.suggestableToSql('u', '$1'), /^\(COALESCE\(u\.show_in_suggestions, NOT FALSE\) IS NOT FALSE OR /);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. GET and PUT /api/users/me/privacy
// ═══════════════════════════════════════════════════════════════════════════

test('the switches read today\'s behaviour for every account that never chose, whatever its age', async () => {
  const minor = await teen('Mina');
  const grown = await adult('Gus');
  const unknown = await mkUser('Nadia'); // no date of birth, as every iPhone signup
  for (const who of [minor, grown, unknown]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call('GET', '/api/users/me/privacy', { token: who.token });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, OPEN, who.name);
  }
  // A choice made reads back as made, at any age.
  const chose = await teen('Tess', { friendsOnly: true, suggested: false });
  assert.deepStrictEqual((await call('GET', '/api/users/me/privacy', { token: chose.token })).body, CLOSED);
});

test('a write changes the one field it names, and the answer is the row\'s', async () => {
  const minor = await teen('Rory');
  let res = await call('PUT', '/api/users/me/privacy', { token: minor.token, body: { invitesFrom: 'friends' } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { invitesFrom: 'friends', showInSuggestions: true });
  let row = (await pool.query('SELECT invites_friends_only, show_in_suggestions FROM users WHERE id = $1', [minor.id])).rows[0];
  assert.deepStrictEqual(row, { invites_friends_only: true, show_in_suggestions: null },
    'the field that was not sent stays unchosen');

  res = await call('PUT', '/api/users/me/privacy', { token: minor.token, body: { showInSuggestions: false } });
  assert.deepStrictEqual(res.body, CLOSED);
  res = await call('PUT', '/api/users/me/privacy', { token: minor.token, body: { invitesFrom: 'everyone', showInSuggestions: true } });
  assert.deepStrictEqual(res.body, OPEN);
  row = (await pool.query('SELECT invites_friends_only, show_in_suggestions FROM users WHERE id = $1', [minor.id])).rows[0];
  assert.deepStrictEqual(row, { invites_friends_only: false, show_in_suggestions: true });
  assert.deepStrictEqual((await call('GET', '/api/users/me/privacy', { token: minor.token })).body, OPEN);
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

test('POST /:id/invite: a teen who never chose is invited by anyone, exactly like an adult', async () => {
  const host = await adult('Host');
  const kid = await teen('Kid');
  const grown = await adult('Grown');
  const unknown = await mkUser('NoDob');
  const flockId = await mkFlock(host);
  const res = await call('POST', `/api/flocks/${flockId}/invite`, { token: host.token, body: { user_ids: [kid.id, grown.id, unknown.id] } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(invitedIds(res), ids(kid, grown, unknown));
  assert.strictEqual(await membershipOf(flockId, kid), 'invited');
});

test('POST /:id/invite: friends only, chosen by a teen or an adult, refuses a stranger like an id nobody holds and lets a friend in', async () => {
  const host = await adult('Host1');
  const friend = await adult('Pal1');
  const kid = await teen('Kid1', { friendsOnly: true });
  const grown = await adult('Strict1', { friendsOnly: true });
  await befriend(kid, friend);
  await befriend(friend, grown);
  const flockId = await mkFlock(host);
  await addMember(flockId, friend, 'accepted');

  // The answer for an id nobody holds, to compare each refusal with.
  const nobody = await call('POST', `/api/flocks/${flockId}/invite`, { token: host.token, body: { user_ids: [2147480000] } });
  assert.strictEqual(nobody.status, 200, nobody.text);
  for (const who of [kid, grown]) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await call('POST', `/api/flocks/${flockId}/invite`, { token: host.token, body: { user_ids: [who.id] } });
    assert.strictEqual(refused.status, 200, refused.text);
    assert.deepStrictEqual(invitedIds(refused), []);
    assert.strictEqual(refused.text, nobody.text, `a refused invite for ${who.name} answers exactly as an id with no account does`);
    // eslint-disable-next-line no-await-in-loop
    assert.strictEqual(await membershipOf(flockId, who), null, 'and writes nothing');
  }

  // A friend on the same plan adds them, which is what the setting allows.
  const allowed = await call('POST', `/api/flocks/${flockId}/invite`, { token: friend.token, body: { user_ids: [kid.id, grown.id] } });
  assert.strictEqual(allowed.status, 200, allowed.text);
  assert.deepStrictEqual(invitedIds(allowed), ids(kid, grown));
  assert.strictEqual(await membershipOf(flockId, kid), 'invited');
});

test('POST /:id/invite: the choice is enforced either way round, at any age', async () => {
  const host = await adult('Host3');
  const strictAdult = await adult('Strict3', { friendsOnly: true });
  const strictTeen = await teen('StrictTeen3', { friendsOnly: true });
  const openTeen = await teen('Open3', { friendsOnly: false });
  const openAdult = await adult('OpenAdult3', { friendsOnly: false });
  const flockId = await mkFlock(host);
  const res = await call('POST', `/api/flocks/${flockId}/invite`, {
    token: host.token, body: { user_ids: [strictAdult.id, strictTeen.id, openTeen.id, openAdult.id] },
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(invitedIds(res), ids(openTeen, openAdult));
  assert.strictEqual(await membershipOf(flockId, strictAdult), null);
  assert.strictEqual(await membershipOf(flockId, strictTeen), null);
});

test('POST /:id/invite: a stranger re-invites a teen who declined, unless they chose friends only', async () => {
  const host = await adult('Host4');
  const kid = await teen('Kid4');
  const strict = await teen('Strict4', { friendsOnly: true });
  const flockId = await mkFlock(host);
  await addMember(flockId, kid, 'declined');
  await addMember(flockId, strict, 'declined');
  const res = await call('POST', `/api/flocks/${flockId}/invite`, { token: host.token, body: { user_ids: [kid.id, strict.id] } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(invitedIds(res), [kid.id]);
  assert.strictEqual(await membershipOf(flockId, kid), 'invited', 'a re-invite works as it always has');
  assert.strictEqual(await membershipOf(flockId, strict), 'declined', 'and the decline of someone who chose friends only stands');
});

test('POST /api/flocks: a new plan seats every invitee who takes invites from its maker', async () => {
  const maker = await adult('Maker');
  const kid = await teen('Kid5');
  const strict = await adult('Strict5', { friendsOnly: true });
  const res = await call('POST', '/api/flocks', { token: maker.token, body: { name: 'Friday plan', invited_user_ids: [kid.id, strict.id] } });
  assert.strictEqual(res.status, 201, res.text);
  assert.deepStrictEqual(res.body.invited_user_ids, [kid.id], 'the echo names who actually got a row');
  assert.strictEqual(await membershipOf(res.body.flock.id, kid), 'invited', 'a teen who never chose is seated, as before');
  assert.strictEqual(await membershipOf(res.body.flock.id, strict), null);

  // Once they are friends, the maker's next plan seats them.
  await befriend(maker, strict);
  const again = await call('POST', '/api/flocks', { token: maker.token, body: { name: 'Saturday plan', invited_user_ids: [strict.id] } });
  assert.strictEqual(again.status, 201, again.text);
  assert.deepStrictEqual(again.body.invited_user_ids, [strict.id]);
});

test('POST /:id/rerun: running a plan again re-invites everyone who takes invites from the rerunner', async () => {
  const runner = await adult('Runner');
  const kid = await teen('Kid6');
  const strict = await teen('Strict6', { friendsOnly: true });
  const source = await mkFlock(runner, { status: 'completed' });
  await addMember(source, kid, 'accepted');
  await addMember(source, strict, 'accepted');

  const res = await call('POST', `/api/flocks/${source}/rerun`, { token: runner.token, body: {} });
  assert.strictEqual(res.status, 201, res.text);
  assert.deepStrictEqual(res.body.invited_user_ids, [kid.id]);
  assert.strictEqual(await membershipOf(res.body.flock.id, strict), null);

  await befriend(strict, runner);
  const again = await call('POST', `/api/flocks/${source}/rerun`, { token: runner.token, body: {} });
  assert.strictEqual(again.status, 201, again.text);
  assert.deepStrictEqual([...again.body.invited_user_ids].sort(byId), ids(kid, strict));
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

test('the flock_invite relay reaches a teen who never chose from anyone, and friends only from a friend only', async () => {
  const host = await adult('Host7');
  const friend = await adult('Pal7');
  const kid = await teen('Kid7');
  const strict = await teen('Strict7', { friendsOnly: true });
  await befriend(friend, strict);
  const flockId = await mkFlock(host);
  await addMember(flockId, friend, 'accepted');
  await addMember(flockId, kid, 'invited');
  await addMember(flockId, strict, 'invited'); // the friend's invite, already written

  // Who got the toast, and from whom.
  const relay = async (sender) => {
    const io = fakeIo();
    const s = fakeSocket(`sock-${sender.id}`, { id: sender.id, name: sender.name });
    handlers.registerHandlers(io, s);
    await s.handlers.get('flock_invite')({ flockId, invitedUserIds: [kid.id, strict.id] });
    return io.emitted
      .filter((e) => e.event === 'flock_invite_received')
      .map((e) => {
        assert.strictEqual(e.payload.invitedBy.userId, sender.id);
        return Number(e.room.slice('user:'.length));
      })
      .sort(byId);
  };

  assert.deepStrictEqual(await relay(host), [kid.id], 'a stranger relayed a toast naming themselves to someone who chose friends only');
  assert.deepStrictEqual(await relay(friend), ids(kid, strict));
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Quick Add and the Suggested rows
// ═══════════════════════════════════════════════════════════════════════════

test('Quick Add keeps a teen who never chose, and leaves out anyone who turned it off', async () => {
  const viewer = await adult('Viewer');
  const bridge = await adult('Bridge');
  const kid = await teen('Kid8');
  const grown = await adult('Grown8');
  const unknown = await mkUser('NoDob8');
  const hidden = await adult('Hidden8', { suggested: false });
  const hiddenTeen = await teen('HiddenTeen8', { suggested: false });
  const openTeen = await teen('OpenTeen8', { suggested: true });
  await befriend(viewer, bridge);
  for (const u of [kid, grown, unknown, hidden, hiddenTeen, openTeen]) {
    // eslint-disable-next-line no-await-in-loop
    await befriend(bridge, u);
  }
  const res = await call('GET', '/api/friends/suggestions', { token: viewer.token });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.suggestions.map((s) => s.id).sort(byId), ids(kid, grown, unknown, openTeen));
});

test('the Suggested row keeps a hidden flock mate for their friends only, and a teen who never chose for everyone', async () => {
  const viewer = await adult('Viewer9');
  const kid = await teen('Kid9');
  const grown = await adult('Grown9');
  const hidden = await adult('Hidden9', { suggested: false });
  const hiddenTeen = await teen('HiddenTeen9', { suggested: false });
  const hiddenFriend = await adult('HiddenFriend9', { suggested: false });
  await befriend(viewer, hiddenFriend);
  const flockId = await mkFlock(viewer, { status: 'completed' });
  for (const u of [kid, grown, hidden, hiddenTeen, hiddenFriend]) {
    // eslint-disable-next-line no-await-in-loop
    await addMember(flockId, u, 'accepted');
  }
  const res = await call('GET', '/api/users/suggested', { token: viewer.token });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.users.map((u) => u.id).sort(byId), ids(kid, grown, hiddenFriend),
    'a friend still sees a friend who turned suggestions off; nobody else sees them');
});

test('existing friendships, requests and searches are untouched by either switch', async () => {
  const kid = await teen('Kid10', { friendsOnly: true, suggested: false });
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

// ═══════════════════════════════════════════════════════════════════════════
// 6. The age defaults, with MINOR_SAFER_DEFAULTS on
// ═══════════════════════════════════════════════════════════════════════════
//
// Off in the build, and kept for the day it is turned on. Each test compiles
// its own switched-on copy of utils/invitesAndSuggestions.js (reachWith) and
// runs it against real rows in the same database: the same fragments, with
// the same arguments, that the doors and the reads build at load.

test('with the age defaults on, a choice never made follows the age', () => {
  const on = reachWith(true);
  const today = '2026-11-02';
  const minorDob = '2011-05-05';
  const adultDob = '1995-05-05';
  const eff = (row) => on.effectiveSettings(row, today);
  assert.deepStrictEqual(eff({ date_of_birth: minorDob }), CLOSED);
  assert.deepStrictEqual(eff({ date_of_birth: adultDob }), OPEN);
  assert.deepStrictEqual(eff({ date_of_birth: null }), OPEN,
    'no date of birth (the iPhone app asks for none) keeps today\'s behaviour');
  assert.deepStrictEqual(eff({ date_of_birth: minorDob, invites_friends_only: false, show_in_suggestions: true }),
    OPEN, 'a minor\'s own choice stands');
  assert.deepStrictEqual(eff({ date_of_birth: adultDob, invites_friends_only: true, show_in_suggestions: false }),
    CLOSED, 'an adult\'s own choice stands');
  assert.deepStrictEqual(eff({ date_of_birth: minorDob, invites_friends_only: false }),
    { invitesFrom: 'everyone', showInSuggestions: false }, 'one choice made leaves the other at its default');
});

test('with the age defaults on, GET /me/privacy\'s own statement gives a teen the age defaults', async () => {
  const on = reachWith(true);
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'users.js'), 'utf8');
  const getSql = src.match(/router\.get\('\/me\/privacy'[\s\S]*?pool\.query\(\s*'([^']+)'/);
  const putReturning = src.match(/router\.put\('\/me\/privacy'[\s\S]*?RETURNING ([^`]+)`/);
  assert.ok(getSql && putReturning, 'could not find the /me/privacy statements in routes/users.js');
  // Both halves hand effectiveSettings the date of birth, so turning the
  // constant on needs no change to the route.
  assert.match(getSql[1], /\bdate_of_birth\b/);
  assert.match(putReturning[1], /\bdate_of_birth\b/);

  const kid = await teen('Kid11');
  const grown = await adult('Grown11');
  const chose = await teen('Chose11', { friendsOnly: false, suggested: true });
  const answer = async (u, r) => r.effectiveSettings((await pool.query(getSql[1], [u.id])).rows[0]);
  assert.deepStrictEqual(await answer(kid, on), CLOSED);
  assert.deepStrictEqual(await answer(grown, on), OPEN);
  assert.deepStrictEqual(await answer(chose, on), OPEN);
  assert.deepStrictEqual(await answer(kid, reach), OPEN, 'and the shipped module answers today\'s behaviour on the same row');
});

test('with the age defaults on, the invite read keeps a teen who never chose from a stranger and lets a friend through', async () => {
  const on = reachWith(true);
  const stranger = await adult('Stranger12');
  const friend = await adult('Pal12');
  const kid = await teen('Kid12');
  const grown = await adult('Grown12');
  const unknown = await mkUser('NoDob12');
  const openTeen = await teen('Open12', { friendsOnly: false });
  const strict = await adult('Strict12', { friendsOnly: true });
  await befriend(kid, friend);
  await befriend(friend, strict);
  const asked = [kid, grown, unknown, openTeen, strict].map((u) => u.id);

  // The directory read the three REST doors make, and the relay's, which asks
  // the same rule of the invitee under its own alias.
  for (const [alias, inviter] of [['users', '$2'], ['iu', '$2']]) {
    const read = `SELECT ${alias}.id FROM users ${alias} WHERE ${alias}.id = ANY($1::int[]) AND ${on.acceptsInvitesFromSql(alias, inviter)}`;
    const reached = async (who) => (await pool.query(read, [asked, who.id])).rows.map((r) => r.id).sort(byId);
    // eslint-disable-next-line no-await-in-loop
    assert.deepStrictEqual(await reached(stranger), ids(grown, unknown, openTeen), alias);
    // eslint-disable-next-line no-await-in-loop
    assert.deepStrictEqual(await reached(friend), ids(kid, grown, unknown, openTeen, strict), alias);
  }
});

test('with the age defaults on, the suggestion reads leave out a teen who never chose, for everyone but their friends', async () => {
  const on = reachWith(true);
  const viewer = await adult('Viewer13');
  const friend = await adult('Pal13');
  const kid = await teen('Kid13');
  const grown = await adult('Grown13');
  const unknown = await mkUser('NoDob13');
  const openTeen = await teen('Open13', { suggested: true });
  const hidden = await adult('Hidden13', { suggested: false });
  await befriend(kid, friend);
  await befriend(hidden, friend);
  const candidates = [kid, grown, unknown, openTeen, hidden].map((u) => u.id);
  const read = `SELECT u.id FROM users u WHERE u.id = ANY($2::int[]) AND ${on.suggestableToSql('u', '$1')}`;
  const shown = async (who) => (await pool.query(read, [who.id, candidates])).rows.map((r) => r.id).sort(byId);
  assert.deepStrictEqual(await shown(viewer), ids(grown, unknown, openTeen));
  assert.deepStrictEqual(await shown(friend), ids(kid, grown, unknown, openTeen, hidden));
});
