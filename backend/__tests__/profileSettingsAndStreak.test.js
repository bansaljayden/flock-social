'use strict';
// Run: node --test __tests__/profileSettingsAndStreak.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// SYNCED SETTINGS, ON A REAL POSTGRES
// ---------------------------------------------------------------------------
// PATCH /api/users/settings used to read the stored blob, merge the partial
// into it in JavaScript and write the whole merged object back. Every device
// sends only the keys it changed, so two saves that overlapped (Crowd alerts
// turned off on the phone while a web tab flushed a flock reorder) both read
// the same old blob, and the second write put the first one's key back. The
// pre-peak crowd push reads crowdAlerts from that row, so the lost save was an
// opt-out the server went on ignoring.
//
// The merge is now the upsert's own `settings || EXCLUDED.settings`, which
// Postgres evaluates against the row as it stands once the statement holds its
// lock. A scripted pool cannot show that, so this file runs the real route
// against a migrated embedded Postgres, holds one save open between its first
// statement and its answer while a second save runs to completion, and reads
// back what was stored.
//
// THE PROFILE STREAK, IN THE PERSON'S OWN DAYS
// ---------------------------------------------------------------------------
// GET /api/users/stats bucketed activity by UTC date and walked back from a
// UTC "today", so an evening in the Americas split at UTC midnight: two
// messages minutes apart counted as two days, and two evenings in a row read
// as a gap. It also counted every flock_members row, and an invite row is
// stamped when somebody ELSE sends the invite. Date arithmetic and zone rules
// are Postgres's here, so these run on the same embedded server.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
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
// builds its Pool from DATABASE_URL at require time, and backend/.env points at
// the live database.
const PG_PORT = pickEmbeddedPgPort('profileSettingsAndStreak');
const DB_NAME = 'flock_profile_settings_streak';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-profile-settings-and-streak';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let seq = 0;

// A hold on the next statement that touches user_settings: it runs, and its
// answer is kept from the route until release() (or a timeout, so a version of
// the route that took a row lock and waited could not wedge the file).
let gate = null;
// When set, the streak read refuses any zone but UTC, the way a Postgres whose
// zone table lacks a name ICU accepted would.
let refuseStreakZone = false;
function holdNextSettingsStatement() {
  let reached;
  let release;
  const g = {
    taken: false,
    reached: new Promise((r) => { reached = r; }),
    released: new Promise((r) => { release = r; }),
  };
  g.arrive = reached;
  g.release = release;
  gate = g;
  return g;
}

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-profile-settings-streak-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'profileSettingsAndStreak', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const query = pool.query;
  pool.query = async function heldQuery(...args) {
    if (refuseStreakZone && typeof args[0] === 'string' && /AS today/.test(args[0])
        && Array.isArray(args[1]) && args[1][1] !== 'UTC') {
      // What Postgres answers for a zone name it does not know.
      throw Object.assign(new Error(`time zone "${args[1][1]}" not recognized`), { code: '22023' });
    }
    const out = await query.apply(this, args);
    const g = gate;
    if (g && !g.taken && typeof args[0] === 'string' && /user_settings/.test(args[0])) {
      g.taken = true;
      g.arrive();
      await Promise.race([g.released, new Promise((r) => setTimeout(r, 2000))]);
    }
    return out;
  };

  ({ signUserToken } = require('../middleware/auth'));

  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/users', require('../routes/users'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  gate = null;
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn('[profileSettingsAndStreak] could not remove %s: %s', dataDir, err.message);
  }
});

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

async function mkUser(name) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified)
     VALUES ($1, 'x', $2, true) RETURNING *`,
    [`u${seq}-${Date.now()}@profile-settings.test`, name]
  );
  return { ...rows[0], token: signUserToken(rows[0]) };
}

const stored = async (user) => {
  const r = await call('GET', '/api/users/settings', { token: user.token });
  assert.equal(r.status, 200, r.text);
  return r.body.settings;
};
const save = (user, body) => call('PATCH', '/api/users/settings', { token: user.token, body });

// ── Settings ─────────────────────────────────────────────────────────────────

test('a save that overlaps another save keeps both changes', async () => {
  const dana = await mkUser('Dana');
  assert.equal((await save(dana, { crowdAlerts: 'true', theme: 'dark' })).status, 200);

  // The phone turns Crowd alerts off. Its save is held just after its first
  // statement on user_settings has answered.
  const hold = holdNextSettingsStatement();
  const phone = save(dana, { crowdAlerts: 'false' });
  await hold.reached;

  // Meanwhile the web tab flushes a flock reorder, start to finish.
  const web = await save(dana, { flockOrder: [3, 1, 2] });
  hold.release();
  const phoneRes = await phone;
  gate = null;

  assert.equal(web.status, 200, web.text);
  assert.equal(phoneRes.status, 200, phoneRes.text);
  assert.deepEqual(await stored(dana), { crowdAlerts: 'false', theme: 'dark', flockOrder: [3, 1, 2] },
    'one of two overlapping saves was lost; the crowd-alerts opt-out must survive a save of another key');
});

test('a burst of saves, one key each, keeps every key', async () => {
  const eli = await mkUser('Eli');
  const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
  const answers = await Promise.all(keys.map((k, i) => save(eli, { [k]: i })));
  assert.deepEqual(answers.map((a) => a.status), keys.map(() => 200));
  const settings = await stored(eli);
  for (const [i, k] of keys.entries()) assert.equal(settings[k], i, `key ${k} was lost to an overlapping save`);
});

test('the first save creates the row, and a later save merges into it', async () => {
  const fay = await mkUser('Fay');
  assert.deepEqual(await stored(fay), {});
  const first = await save(fay, { pinnedFlockIds: [7] });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body.settings, { pinnedFlockIds: [7] });
  const second = await save(fay, { pinnedFlockIds: [7, 9], crowdAlerts: 'false' });
  assert.deepEqual(second.body.settings, { pinnedFlockIds: [7, 9], crowdAlerts: 'false' },
    'a key sent again replaces its value; an array is not concatenated');
});

test('a save that would push the merged blob past the cap is refused and changes nothing', async () => {
  const gus = await mkUser('Gus');
  const big = 'x'.repeat(7000);
  assert.equal((await save(gus, { a: big })).status, 200);
  assert.equal((await save(gus, { b: big })).status, 200);

  const over = await save(gus, { c: 'y'.repeat(3000) });
  assert.equal(over.status, 400, over.text);
  assert.equal(over.body.error, 'Settings storage limit reached');
  assert.deepEqual(Object.keys(await stored(gus)).sort(), ['a', 'b'], 'a refused save wrote its key anyway');

  // Shrinking a key near the cap is still allowed.
  const smaller = await save(gus, { a: 'short' });
  assert.equal(smaller.status, 200, smaller.text);
  assert.equal((await stored(gus)).a, 'short');

  // The payload cap still answers first.
  const huge = await save(gus, { d: 'z'.repeat(9000) });
  assert.equal(huge.status, 400);
  assert.equal(huge.body.error, 'Settings payload too large');
});

// A blob exactly `width` characters long as JSON.stringify prints it, made of
// many short members (plus nested objects and arrays), which is where Postgres's
// own printing (a space after every ':' and ',') reads widest against it.
// `extra` members come first; 'fill' pads to the width.
function blobOfWidth(width, extra = {}) {
  const blob = { ...extra };
  for (let i = 0; i < 300; i += 1) blob[`p${i}`] = 'v'.repeat(12);
  blob.nested = { list: [1, 2, 3], deeper: [{ a: 1, b: 'x, y: z' }, { c: [] }, {}] };
  blob.fill = '';
  blob.fill = 'f'.repeat(width - JSON.stringify(blob).length);
  assert.equal(JSON.stringify(blob).length, width);
  return blob;
}
const MAX_SETTINGS_STORED = 16384;
const printedWidth = async (userId) => (await pool.query(
  'SELECT length(settings::text) AS n FROM user_settings WHERE user_id = $1', [userId]
)).rows[0].n;

test('a row stored under the cap still takes a one-key save, however Postgres prints it', async () => {
  // Written the way the route wrote it before the merge moved into SQL: the
  // cap checked JSON.stringify of the merged object. Printed by Postgres, the
  // same row is hundreds of characters over, and measured that way it refused
  // every save, the Crowd alerts opt-out included.
  const hal = await mkUser('Hal');
  const blob = blobOfWidth(MAX_SETTINGS_STORED - 8, { crowdAlerts: 'true' });
  await pool.query('INSERT INTO user_settings (user_id, settings) VALUES ($1, $2::jsonb)', [hal.id, JSON.stringify(blob)]);
  assert.ok(await printedWidth(hal.id) > MAX_SETTINGS_STORED + 500,
    'the fixture no longer reads wider in Postgres than in JSON.stringify, so this test proves nothing');

  const optOut = await save(hal, { crowdAlerts: 'false' });
  assert.equal(optOut.status, 200, optOut.text);
  assert.equal((await stored(hal)).crowdAlerts, 'false', 'the opt-out was refused by a cap the row was already under');
});

test('the cap is JSON.stringify\'s width of the merged blob, to the character', async () => {
  const ivy = await mkUser('Ivy');
  const blob = blobOfWidth(MAX_SETTINGS_STORED - 20, { room: '' });
  await pool.query('INSERT INTO user_settings (user_id, settings) VALUES ($1, $2::jsonb)', [ivy.id, JSON.stringify(blob)]);

  // Exactly at the cap: allowed.
  const at = await save(ivy, { room: 'r'.repeat(20) });
  assert.equal(at.status, 200, at.text);
  assert.equal(JSON.stringify(await stored(ivy)).length, MAX_SETTINGS_STORED);

  // One past it: refused, and the row is left as it was.
  const past = await save(ivy, { room: 'r'.repeat(21) });
  assert.equal(past.status, 400, past.text);
  assert.equal(past.body.error, 'Settings storage limit reached');
  assert.equal((await stored(ivy)).room, 'r'.repeat(20));

  // A ', ' or ': ' inside a string is part of the value, not a separator, and
  // counts: swapping 20 characters for 20 others is still exactly at the cap.
  const sameWidth = await save(ivy, { room: ', : '.repeat(5) });
  assert.equal(sameWidth.status, 200, sameWidth.text);
  assert.equal((await stored(ivy)).room, ', : '.repeat(5));
  const over = await save(ivy, { room: `${', : '.repeat(5)},` });
  assert.equal(over.status, 400, over.text);
});

// ── The profile streak ───────────────────────────────────────────────────────
// America/Phoenix keeps UTC-7 all year, so every wall-clock time below lands on
// the same UTC date whatever the season: 16:00 there is 23:00 UTC the same day,
// and 17:05 or 18:00 there is past midnight UTC, the next day. The moments are
// placed relative to today in Phoenix, so the file means the same thing on
// whatever day it runs.
const PHOENIX = 'America/Phoenix';
const statsFor = (user, qs = `?tz=${encodeURIComponent(PHOENIX)}`) =>
  call('GET', `/api/users/stats${qs}`, { token: user.token });

let hostFlockId = null;
async function hostFlock() {
  if (hostFlockId) return hostFlockId;
  // Created by somebody else and with no membership rows, so the messages sent
  // in it are the only activity a test's person has.
  const host = await mkUser('Host');
  const { rows } = await pool.query(
    "INSERT INTO flocks (name, creator_id, status) VALUES ('Tacos', $1, 'planning') RETURNING id",
    [host.id]
  );
  hostFlockId = rows[0].id;
  return hostFlockId;
}

// A message sent at `clock` (HH:MM) in `zone`, `daysAgo` local days before
// today there, stored the way the app stores it: naive UTC.
async function messageAt(user, zone, daysAgo, clock) {
  await pool.query(
    `INSERT INTO messages (flock_id, sender_id, message_text, created_at)
     VALUES ($4, $5, 'hi',
       ((date_trunc('day', NOW() AT TIME ZONE $1::text) - make_interval(days => $2::int) + $3::interval)
         AT TIME ZONE $1::text) AT TIME ZONE 'UTC')`,
    [zone, daysAgo, clock, await hostFlock(), user.id]
  );
}

test('the streak counts the person\'s own days: two evenings in a row are a streak of two', async () => {
  // The day before yesterday at 4 PM (23:00 UTC that day) and yesterday at
  // 6 PM (01:00 UTC today). In UTC days those are two apart with a gap.
  const maya = await mkUser('Maya');
  await messageAt(maya, PHOENIX, 2, '16:00');
  await messageAt(maya, PHOENIX, 1, '18:00');
  const r = await statsFor(maya);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.streak, 2, 'two consecutive local evenings must be a two-day streak');
});

test('two messages either side of UTC midnight on one evening are one day, not two', async () => {
  const noa = await mkUser('Noa');
  await messageAt(noa, PHOENIX, 1, '16:55');
  await messageAt(noa, PHOENIX, 1, '17:05');
  const r = await statsFor(noa);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.streak, 1, 'one evening counted as two days');
});

test('an invite nobody answered, or one that was declined, is not a day of activity', async () => {
  const ora = await mkUser('Ora');
  const host = await mkUser('Inviter');
  const mkPlan = async () => (await pool.query(
    "INSERT INTO flocks (name, creator_id, status) VALUES ('Plan', $1, 'planning') RETURNING id", [host.id]
  )).rows[0].id;
  // Invited yesterday and today, and one declined today. joined_at is stamped
  // when the invite is written, which is somebody else acting.
  await pool.query(
    `INSERT INTO flock_members (flock_id, user_id, status, joined_at)
     VALUES ($1, $3, 'invited', (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day'),
            ($2, $3, 'invited', NOW() AT TIME ZONE 'UTC')`,
    [await mkPlan(), await mkPlan(), ora.id]
  );
  await pool.query(
    "INSERT INTO flock_members (flock_id, user_id, status, joined_at) VALUES ($1, $2, 'declined', NOW() AT TIME ZONE 'UTC')",
    [await mkPlan(), ora.id]
  );
  let r = await statsFor(ora);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.streak, 0, 'invites the person never accepted kept a streak alive');

  // Accepting one is a join, and today counts.
  await pool.query(
    "INSERT INTO flock_members (flock_id, user_id, status, joined_at) VALUES ($1, $2, 'accepted', NOW() AT TIME ZONE 'UTC')",
    [await mkPlan(), ora.id]
  );
  r = await statsFor(ora);
  assert.equal(r.body.streak, 1);
});

test('without ?tz the streak uses the zone the device last reported, and a zone nobody knows is UTC', async () => {
  const pia = await mkUser('Pia');
  await pool.query(
    `INSERT INTO device_tokens (user_id, token, device_type, timezone, timezone_reported_at)
     VALUES ($1, $2, 'ios', $3, NOW())`,
    [pia.id, `tok-${pia.id}-${Date.now()}`, PHOENIX]
  );
  await messageAt(pia, PHOENIX, 2, '16:00');
  await messageAt(pia, PHOENIX, 1, '18:00');
  const r = await statsFor(pia, '');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.streak, 2, 'an older build that sends no zone should still be counted in its device\'s days');

  // A zone that is not one, from the query and from the device row, is never
  // handed to Postgres: the profile answers, counted in UTC.
  const quinn = await mkUser('Quinn');
  await pool.query(
    `INSERT INTO device_tokens (user_id, token, device_type, timezone, timezone_reported_at)
     VALUES ($1, $2, 'web', 'Mars/Olympus''; --', NOW())`,
    [quinn.id, `tok-${quinn.id}-${Date.now()}`]
  );
  await pool.query(
    "INSERT INTO messages (flock_id, sender_id, message_text) VALUES ($1, $2, 'now')",
    [await hostFlock(), quinn.id]
  );
  for (const qs of ['?tz=Not%2FAZone', '?tz[]=America%2FPhoenix', '']) {
    const q = await statsFor(quinn, qs);
    assert.equal(q.status, 200, `${qs}: ${q.text}`);
    assert.equal(q.body.streak, 1, `${qs}: a message sent just now is today's activity in any zone`);
  }
});

test('a zone ICU accepts and Postgres does not is counted in UTC rather than failing the profile', async () => {
  // The code the route falls back on is the one this Postgres really uses.
  await assert.rejects(pool.query("SELECT NOW() AT TIME ZONE 'Mars/Olympus'"), { code: '22023' });

  const rae = await mkUser('Rae');
  await pool.query(
    "INSERT INTO messages (flock_id, sender_id, message_text) VALUES ($1, $2, 'now')",
    [await hostFlock(), rae.id]
  );
  refuseStreakZone = true;
  try {
    const r = await statsFor(rae);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.streak, 1);
  } finally {
    refuseStreakZone = false;
  }
});
