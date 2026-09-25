'use strict';
// ---------------------------------------------------------------------------
// AN SOS, ITS STAND-DOWN, AND THE LOCATION THAT MUST NOT OUTLIVE IT.
// On a real, migrated Postgres, through the real routes.
//
// THE DEFECT. An SOS pressed indoors goes out with no position. The app keeps
// asking the phone for a fix for up to 45 seconds and posts it as a second
// alert, which /alert lets through its sixty second floor because the last
// alert had no location and this one does. Standing the alert down wrote
// nothing on the alert, so when the fix landed after "Tell them I'm OK" the
// rule still held, and a new emergency email and a new flock alarm with a map
// went out to everybody who had just been told the person was fine.
//
// Migration 084 gives the alert a withdrawn_at, the stand-down sets it under
// the same per-user advisory lock the alert's claim takes, and /alert refuses
// a follow-up to a withdrawn alert. The app's half (the chase ends on the
// stand-down) is frontend/src/__tests__/sosFollowUpChase.test.js.
//
// Also here, because they need real rows to mean anything:
//   * the stand-down reaches everyone any still-standing alert reached, not
//     only the newest alert's people (a flockmate who left the plan, a contact
//     removed, between two alerts);
//   * a follow-up goes only to the addresses the first alert went to;
//   * the flock leg of an alert stood down before it rang tells nobody.
//
// Mail and pushes are captured, never sent: emailService.sendEmail and
// pushHelper.pushAlways are replaced before routes/safety.js loads.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('sosStandDownEndsTheChase');
const DB_NAME = 'flock_sos_stand_down_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-sos-stand-down';
delete process.env.RESEND_API_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

// Every message that would have left the building.
const emailService = require('../services/emailService');
const mails = [];
emailService.sendEmail = async (msg) => {
  mails.push(msg);
  return { sent: true, id: `m${mails.length}` };
};
const pushHelper = require('../services/pushHelper');
const pushes = [];
pushHelper.pushAlways = async (userId, title, body, data) => {
  pushes.push({ userId: Number(userId), title, body, data });
  return { sent: 1 };
};
const emits = [];
const io = { to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }) };

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let S;
let seq = 0;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-sos-stand-down-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'sosStandDownEndsTheChase', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  ({ signUserToken } = require('../middleware/auth'));
  const safetyRoutes = require('../routes/safety');
  S = safetyRoutes.__test;
  const app = express();
  app.use(express.json());
  app.set('io', io);
  app.use('/api/safety', safetyRoutes);
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The flock leg is fire-and-forget after the response. Wait for it by what it
// leaves behind rather than by a guess at how long it takes.
async function until(check, what) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function mkUser(name) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified)
     VALUES ($1, 'x', $2, true) RETURNING *`,
    [`sos${seq}-${Date.now()}@stand-down.test`, name]
  );
  return { ...rows[0], token: signUserToken(rows[0]) };
}

// A confirmed plan an hour from now, with everyone accepted: the audience the
// flock leg asks for.
async function mkPlan(sender, members) {
  const { rows: [flock] } = await pool.query(
    `INSERT INTO flocks (name, creator_id, event_time, status)
     VALUES ('Tonight', $1, (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 hour', 'confirmed') RETURNING id`,
    [sender.id]
  );
  for (const u of [sender, ...members]) {
    await pool.query('INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, $3)', [flock.id, u.id, 'accepted']);
  }
  return flock.id;
}

async function addContact(user, name, email, phone) {
  await pool.query(
    `INSERT INTO trusted_contacts (user_id, contact_name, contact_phone, contact_email)
     VALUES ($1, $2, $3, $4)`,
    [user.id, name, phone, email]
  );
}

async function alertRows(user) {
  const { rows } = await pool.query(
    `SELECT id, withdrawn_at, contacts_alerted, flock_recipient_ids, contact_recipients
       FROM emergency_alerts WHERE user_id = $1 ORDER BY id ASC`,
    [user.id]
  );
  return rows;
}

// Everything that reached anybody on behalf of `user` since `mark`.
function since(mark) {
  return {
    mails: mails.slice(mark.mails),
    pushes: pushes.slice(mark.pushes),
    emits: emits.slice(mark.emits),
  };
}
const here = () => ({ mails: mails.length, pushes: pushes.length, emits: emits.length });

const FIX = { latitude: 40.7128, longitude: -74.006, accuracy: 25, includeLocation: true };

// ===========================================================================
// The follow-up cannot outlive the stand-down
// ===========================================================================

test('after "I am OK", the location follow-up is refused: no row, no mail, no push, no signal', async () => {
  const ava = await mkUser('Ava');
  const f1 = await mkUser('Fin');
  const f2 = await mkUser('Gus');
  await mkPlan(ava, [f1, f2]);
  await addContact(ava, 'Mum', 'mum.ava@example.com', '5550101');
  await addContact(ava, 'Dad', 'dad.ava@example.com', '5550102');

  // The SOS, indoors: no position.
  const alarm = await call('POST', '/api/safety/alert', { token: ava.token, body: { includeLocation: false } });
  assert.strictEqual(alarm.status, 200, JSON.stringify(alarm.body));
  const alertId = alarm.body.alertId;
  assert.ok(Number.isInteger(alertId), 'the app is handed the id its chase will name');
  await until(async () => (await alertRows(ava))[0].flock_recipient_ids.length === 2, 'the flock leg');

  // "Tell them I'm OK".
  const ok = await call('POST', '/api/safety/alert/cancel', { token: ava.token, body: {} });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const [row] = await alertRows(ava);
  assert.ok(row.withdrawn_at, 'the alert is marked withdrawn');
  await sleep(50);
  const afterOk = here();

  // The fix lands. The app's chase names the alert it follows...
  const tagged = await call('POST', '/api/safety/alert', { token: ava.token, body: { ...FIX, followUpTo: alertId } });
  assert.strictEqual(tagged.status, 409, JSON.stringify(tagged.body));
  assert.strictEqual(tagged.body.withdrawn, true);
  // ...and an older build's chase does not, and is refused by the floor.
  const untagged = await call('POST', '/api/safety/alert', { token: ava.token, body: FIX });
  assert.strictEqual(untagged.status, 429, JSON.stringify(untagged.body));
  assert.strictEqual(untagged.body.withdrawn, true);
  assert.ok(!('alreadySent' in untagged.body));

  await sleep(100);
  const leaked = since(afterOk);
  assert.deepStrictEqual(leaked.mails.map((m) => m.to), [], 'no contact heard anything after the all-clear');
  assert.deepStrictEqual(leaked.pushes.map((p) => p.data.type), [], 'no flockmate was pushed after the all-clear');
  assert.deepStrictEqual(leaked.emits.map((e) => e.event), [], 'no flockmate was signalled after the all-clear');
  assert.strictEqual((await alertRows(ava)).length, 1, 'no alert row was written');
});

test('the whole night in order: alarm, all-clear, and nothing after it', async () => {
  // The same sequence, read as what each person received. Every one of them
  // ends on the all-clear.
  const ava = await mkUser('Ava');
  const f1 = await mkUser('Fin');
  await mkPlan(ava, [f1]);
  await addContact(ava, 'Mum', 'mum.night@example.com', '5550111');
  const start = here();

  const alarm = await call('POST', '/api/safety/alert', { token: ava.token, body: { includeLocation: false } });
  assert.strictEqual(alarm.status, 200);
  await until(async () => (await alertRows(ava))[0].flock_recipient_ids.length === 1, 'the flock leg');
  await call('POST', '/api/safety/alert/cancel', { token: ava.token, body: {} });
  await call('POST', '/api/safety/alert', { token: ava.token, body: { ...FIX, followUpTo: alarm.body.alertId } });
  await sleep(100);

  const got = since(start);
  assert.deepStrictEqual(got.mails.map((m) => [m.to, /is OK$/.test(m.subject) ? 'all-clear' : 'alarm']),
    [['mum.night@example.com', 'alarm'], ['mum.night@example.com', 'all-clear']]);
  assert.deepStrictEqual(got.pushes.map((p) => [p.userId, p.data.type]),
    [[f1.id, 'safety_alert'], [f1.id, 'safety_alert_cancelled']]);
});

test('past the floor, a new press after the all-clear is a new alert, not an update to the withdrawn one', async () => {
  const bo = await mkUser('Bo');
  await addContact(bo, 'Mum', 'mum.bo@example.com', '5550121');
  const alarm = await call('POST', '/api/safety/alert', { token: bo.token, body: { includeLocation: false } });
  assert.strictEqual(alarm.status, 200);
  await call('POST', '/api/safety/alert/cancel', { token: bo.token, body: {} });
  // Ninety seconds on.
  await pool.query(`UPDATE emergency_alerts SET created_at = created_at - INTERVAL '90 seconds' WHERE user_id = $1`, [bo.id]);
  const mark = here();

  const again = await call('POST', '/api/safety/alert', { token: bo.token, body: FIX });
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));
  const [mail] = since(mark).mails;
  assert.strictEqual(mail.to, 'mum.bo@example.com');
  assert.doesNotMatch(mail.subject, /Update/);
  assert.doesNotMatch(mail.html, /This is an update/);
});

// ===========================================================================
// The stand-down reaches everyone any standing alert reached
// ===========================================================================

test('a flockmate who left and a contact removed between two alerts are still told it is over', async () => {
  const bea = await mkUser('Bea');
  const g1 = await mkUser('Gil');
  const g2 = await mkUser('Hal');
  const flockId = await mkPlan(bea, [g1, g2]);
  await addContact(bea, 'Mum', 'mum.bea@example.com', '5550131');
  await addContact(bea, 'Dad', 'dad.bea@example.com', '5550132');

  // First alert: both contacts, both flockmates.
  const first = await call('POST', '/api/safety/alert', { token: bea.token, body: { includeLocation: false } });
  assert.strictEqual(first.status, 200);
  await until(async () => (await alertRows(bea))[0].flock_recipient_ids.length === 2, 'the first flock leg');

  // Hal leaves the plan, Dad is removed, Nan is added.
  await pool.query('UPDATE flock_members SET status = $1 WHERE flock_id = $2 AND user_id = $3', ['declined', flockId, g2.id]);
  await pool.query('DELETE FROM trusted_contacts WHERE user_id = $1 AND contact_email = $2', [bea.id, 'dad.bea@example.com']);
  await addContact(bea, 'Nan', 'nan.bea@example.com', '5550133');

  // Two minutes later she moves and presses again, with a fix this time: an
  // escalation, to the list and the plan as they are now.
  await pool.query(`UPDATE emergency_alerts SET created_at = created_at - INTERVAL '120 seconds' WHERE user_id = $1`, [bea.id]);
  const second = await call('POST', '/api/safety/alert', { token: bea.token, body: FIX });
  assert.strictEqual(second.status, 200, JSON.stringify(second.body));
  await until(async () => (await alertRows(bea))[1]?.flock_recipient_ids.length === 1, 'the second flock leg');
  const rows = await alertRows(bea);
  assert.deepStrictEqual(rows[1].flock_recipient_ids, [g1.id], 'the second alert reached only who was on the plan then');

  const mark = here();
  const ok = await call('POST', '/api/safety/alert/cancel', { token: bea.token, body: {} });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  await until(async () => since(mark).pushes.length >= 2, 'the stand-down pushes');

  const got = since(mark);
  assert.deepStrictEqual(got.mails.map((m) => m.to).sort(),
    ['dad.bea@example.com', 'mum.bea@example.com', 'nan.bea@example.com'],
    'Dad got the first alarm and is told it is over although he is off the list; Mum once, not twice');
  assert.deepStrictEqual(got.pushes.map((p) => p.userId).sort((a, b) => a - b), [g1.id, g2.id].sort((a, b) => a - b),
    'Hal left the plan but holds the first alarm, so he is told too');
  assert.ok(got.pushes.every((p) => p.data.type === 'safety_alert_cancelled'));
  assert.ok((await alertRows(bea)).every((r) => r.withdrawn_at), 'both alerts are withdrawn');
});

test('a follow-up goes only to the addresses the first alert went to, and to its flock', async () => {
  const cy = await mkUser('Cy');
  const h1 = await mkUser('Ike');
  await mkPlan(cy, [h1]);
  await addContact(cy, 'Mum', 'mum.cy@example.com', '5550141');

  const first = await call('POST', '/api/safety/alert', { token: cy.token, body: { includeLocation: false } });
  assert.strictEqual(first.status, 200);
  await until(async () => (await alertRows(cy))[0].flock_recipient_ids.length === 1, 'the flock leg');

  // An address added in the seconds after the SOS never received it.
  await sleep(20);
  await addContact(cy, 'Eve', 'eve.cy@example.com', '5550142');
  const mark = here();

  const follow = await call('POST', '/api/safety/alert', { token: cy.token, body: { ...FIX, followUpTo: first.body.alertId } });
  assert.strictEqual(follow.status, 200, JSON.stringify(follow.body));
  await until(async () => since(mark).pushes.length >= 1, 'the follow-up flock leg');
  const got = since(mark);
  assert.deepStrictEqual(got.mails.map((m) => m.to), ['mum.cy@example.com'],
    'Eve is not mailed an "update" to an alarm she never got, past the do-not-mail list');
  assert.match(got.mails[0].subject, /Update/);
  assert.deepStrictEqual(got.pushes.map((p) => p.userId), [h1.id]);
  assert.strictEqual(got.pushes[0].data.latitude, FIX.latitude);
});

// ===========================================================================
// The flock leg of an alert withdrawn before it rang
// ===========================================================================

test('a flock leg that finds its alert already withdrawn tells nobody and records nobody', async () => {
  const di = await mkUser('Di');
  const j1 = await mkUser('Jo');
  await mkPlan(di, [j1]);
  const { rows: [row] } = await pool.query(
    `INSERT INTO emergency_alerts (user_id, latitude, longitude, contacts_alerted, flock_recipient_ids, contact_recipients, withdrawn_at)
     VALUES ($1, NULL, NULL, 1, '{}'::int[], '[]'::jsonb, NOW()) RETURNING id`,
    [di.id]
  );
  const mark = here();
  const leg = await S.alertFlockMembers(io, { id: di.id, name: 'Di' }, null, 1, row.id);
  assert.strictEqual(leg.withdrawn, true);
  assert.deepStrictEqual(since(mark).pushes, []);
  assert.deepStrictEqual(since(mark).emits, []);
  const [after] = await alertRows(di);
  assert.deepStrictEqual(after.flock_recipient_ids, [], 'nobody is recorded, so no all-clear goes to people who heard nothing');
});
