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
//   * the flock leg of an alert stood down before it rang tells nobody;
//   * an OLDER BUILD, which never names the alert its chase follows, is held
//     off after "I'm OK" for as long as its fix can still arrive. Its fix can
//     come 106 seconds after the alert (the app's 30 second wait for the first
//     answer, its 45 second chase, and a 30 second leash on the follow-up),
//     and the sixty second floor this used to lean on was passed by a slow
//     email fan-out followed by a full chase;
//   * an ALARM PUSH never lands after its all-clear. They share one
//     lock-screen slot, so an alarm reaching a phone after "I'm OK" put
//     "needs help" back over it: one not yet at the provider when the
//     stand-down committed, one still running there, or a retry queued by a
//     send that failed after the stand-down had cleared the outbox;
//   * and an ALL-CLEAR never lands after a newer alarm that still stands. A
//     new SOS more than two minutes after the first is past every hold, and
//     an all-clear for the old alert still at the provider landed on top of
//     the new alarm, so the phone said "says they are OK" during an
//     emergency. Whatever lands last is checked against emergency_alerts, in
//     every order: an all-clear after a newer alarm, two all-clears around
//     one, and an older alarm after a newer one.
//
// Mail and pushes are captured, never sent: emailService.sendEmail and
// pushHelper.pushAlways are replaced before routes/safety.js loads. The push
// tests at the bottom let a captured push go on into the real pushHelper
// (pushThrough), with the provider itself replaced by
// firebaseService.__setSenderForTests, so what reaches each phone, and in what
// order, is recorded without anything leaving this machine.
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
const firebaseService = require('../services/firebaseService');
const pushes = [];
// Off, a push stops here. On, it carries on into the real pushHelper, which is
// what the push tests at the bottom need; the provider is stubbed there.
const realPushAlways = pushHelper.pushAlways;
let pushThrough = false;
pushHelper.pushAlways = async (userId, title, body, data) => {
  pushes.push({ userId: Number(userId), title, body, data });
  if (pushThrough) return realPushAlways(userId, title, body, data);
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

test('past the hold, a new press after the all-clear is a new alert, not an update to the withdrawn one', async () => {
  const bo = await mkUser('Bo');
  await addContact(bo, 'Mum', 'mum.bo@example.com', '5550121');
  const alarm = await call('POST', '/api/safety/alert', { token: bo.token, body: { includeLocation: false } });
  assert.strictEqual(alarm.status, 200);
  await call('POST', '/api/safety/alert/cancel', { token: bo.token, body: {} });
  // Two minutes and five seconds on: past the hold a press that brings a
  // location keeps after a stand-down of an alert that had none (it has the
  // shape of an older build's chase until then; see the tests below).
  await pool.query(`UPDATE emergency_alerts SET created_at = created_at - INTERVAL '125 seconds' WHERE user_id = $1`, [bo.id]);
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
  // Mum was on the list well before the SOS. Written a second back, because
  // the route compares her row's time with the alert's claim time after that
  // has been through a JS Date, which keeps milliseconds only: a contact row
  // written inside the same millisecond as the claim read as added after it,
  // and this test failed now and then for that alone.
  await pool.query(`UPDATE trusted_contacts SET created_at = created_at - INTERVAL '1 second' WHERE user_id = $1`, [cy.id]);

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

// ===========================================================================
// An older build's chase, after "I'm OK"
// ===========================================================================
//
// The build in App Review never names the alert its chase follows, and its
// stand-down does not end the chase, so time since the alert is all that tells
// its fix from a fresh press (routes/safety.js, STOOD_DOWN_CHASE_HOLD_MS).

// "Tell them I'm OK", then the clock moved on: every alert row of the user is
// made `seconds` older, which is what the refusal measures from.
async function standDownAndAge(user, seconds) {
  const ok = await call('POST', '/api/safety/alert/cancel', { token: user.token, body: {} });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  await pool.query(
    `UPDATE emergency_alerts SET created_at = created_at - ($2::int * INTERVAL '1 second') WHERE user_id = $1`,
    [user.id, seconds]
  );
  await sleep(50);
}

const secondsNamed = (res) => Number(((res.body && res.body.error) || '').match(/in (\d+) seconds?/)?.[1]);

test('an older build\'s fix 100 seconds after the alert, and after "I am OK", is refused, and says how long is left', async () => {
  // The sixty second floor this used to stop at was passed by a slow email
  // fan-out and a full chase, and the fix went out as a new alert.
  const ed = await mkUser('Ed');
  const k1 = await mkUser('Kay');
  await mkPlan(ed, [k1]);
  await addContact(ed, 'Mum', 'mum.ed@example.com', '5550161');
  const alarm = await call('POST', '/api/safety/alert', { token: ed.token, body: { includeLocation: false } });
  assert.strictEqual(alarm.status, 200);
  await until(async () => (await alertRows(ed))[0].flock_recipient_ids.length === 1, 'the flock leg');
  await standDownAndAge(ed, 100);
  const mark = here();

  // What that build posts when its chase lands: a fix, and no followUpTo.
  const late = await call('POST', '/api/safety/alert', { token: ed.token, body: FIX });
  assert.strictEqual(late.status, 429, JSON.stringify(late.body));
  assert.strictEqual(late.body.withdrawn, true);
  assert.ok(!('alreadySent' in late.body));
  // Twenty seconds of the two minutes are left, less the request's own time.
  const left = secondsNamed(late);
  assert.ok(left >= 18 && left <= 20, `the wait named is the hold's, not the old floor's: ${late.body.error}`);
  assert.match(late.body.error, /911/);

  await sleep(100);
  const leaked = since(mark);
  assert.deepStrictEqual(leaked.mails.map((m) => m.to), [], 'no new emergency email');
  assert.deepStrictEqual(leaked.pushes.map((p) => p.data.type), [], 'no new flock alarm');
  assert.deepStrictEqual(leaked.emits.map((e) => e.event), []);
  assert.strictEqual((await alertRows(ed)).length, 1, 'no alert row was written');
});

test('the longer hold is for the chase\'s shape alone: anything else waits out the sixty second floor', async () => {
  // A chase runs only after an alert that went out without a location, and it
  // posts only a fix. A press without a location, or after an alert that had
  // one, cannot be that chase, and every second of this refusal is a second
  // somebody who said "I'm OK" and needs help again is told to wait.
  const gil = await mkUser('Gil');
  await addContact(gil, 'Mum', 'mum.gil@example.com', '5550181');
  assert.strictEqual((await call('POST', '/api/safety/alert', { token: gil.token, body: { includeLocation: false } })).status, 200);
  await standDownAndAge(gil, 70);
  const bare = await call('POST', '/api/safety/alert', { token: gil.token, body: { includeLocation: false } });
  assert.strictEqual(bare.status, 200, JSON.stringify(bare.body));

  const hal = await mkUser('Hal');
  await addContact(hal, 'Mum', 'mum.hal@example.com', '5550182');
  assert.strictEqual((await call('POST', '/api/safety/alert', { token: hal.token, body: FIX })).status, 200);
  await standDownAndAge(hal, 70);
  const located = await call('POST', '/api/safety/alert', { token: hal.token, body: FIX });
  assert.strictEqual(located.status, 200, JSON.stringify(located.body));

  // Inside the floor both kinds are still refused, and the wait is the floor's.
  const ivy = await mkUser('Ivy');
  await addContact(ivy, 'Mum', 'mum.ivy@example.com', '5550183');
  assert.strictEqual((await call('POST', '/api/safety/alert', { token: ivy.token, body: FIX })).status, 200);
  await standDownAndAge(ivy, 30);
  const early = await call('POST', '/api/safety/alert', { token: ivy.token, body: FIX });
  assert.strictEqual(early.status, 429, JSON.stringify(early.body));
  const left = secondsNamed(early);
  assert.ok(left >= 28 && left <= 30, early.body.error);
});

test('when the attempt ceiling is already reached, the refusal after "I am OK" names no time the ceiling would break', async () => {
  const jon = await mkUser('Jon');
  await addContact(jon, 'Mum', 'mum.jon@example.com', '5550191');
  // Five attempts earlier in the quarter hour that reached nobody.
  for (let i = 0; i < 5; i += 1) {
    await pool.query(
      `INSERT INTO emergency_alerts (user_id, contacts_alerted, flock_recipient_ids, contact_recipients)
       VALUES ($1, 0, '{}'::int[], '[]'::jsonb)`,
      [jon.id]
    );
  }
  await pool.query(`UPDATE emergency_alerts SET created_at = created_at - INTERVAL '5 minutes' WHERE user_id = $1`, [jon.id]);
  const alarm = await call('POST', '/api/safety/alert', { token: jon.token, body: { includeLocation: false } });
  assert.strictEqual(alarm.status, 200, JSON.stringify(alarm.body));
  await standDownAndAge(jon, 100);

  const res = await call('POST', '/api/safety/alert', { token: jon.token, body: FIX });
  assert.strictEqual(res.status, 429, JSON.stringify(res.body));
  assert.strictEqual(res.body.withdrawn, true);
  assert.match(res.body.error, /several alerts/);
  assert.doesNotMatch(res.body.error, /\d+ seconds?/, 'it promised a time, and the ceiling refused the press made then');
  assert.match(res.body.error, /911/);
});

// ===========================================================================
// An alarm push never lands after its all-clear
// ===========================================================================
//
// The alarm and the all-clear share one lock-screen slot per sender, so the
// last of the two to reach a phone is what it shows, and a tap on "needs help"
// opens the full-screen alarm on any build that has not seen the stand-down.
// These run the real pushHelper on these rows, with only the provider stubbed.

// A registered phone for `user`.
async function addPhone(user) {
  seq += 1;
  const token = `fcm-sos-${seq}-${Date.now()}-${'x'.repeat(60)}`;
  const { rows: [row] } = await pool.query(
    `INSERT INTO device_tokens (user_id, token, device_type) VALUES ($1, $2, 'ios') RETURNING id`,
    [user.id, token]
  );
  return { token, id: row.id };
}

// The provider as the phones see it. `landed` is every message it accepted, in
// the order it accepted them. `hold` picks messages that stay running at the
// provider until the test lets each one land, or fail with a 5xx: a send still
// out, which firebase-admin keeps retrying well past our 8 second deadline.
function stubProvider({ hold = () => false } = {}) {
  const landed = [];
  const held = [];
  firebaseService.__setSenderForTests((message) => {
    if (!hold(message)) {
      landed.push(message);
      return `ok-${landed.length}`;
    }
    return new Promise((resolve, reject) => {
      held.push({
        message,
        land: () => { landed.push(message); resolve(`ok-${landed.length}`); },
        fail: () => {
          const err = new Error('Internal error encountered.');
          err.code = 'messaging/internal-error';
          reject(err);
        },
      });
    });
  });
  return { landed, held };
}

function stopPushThrough() {
  pushThrough = false;
  firebaseService.__setSenderForTests(null);
  pushHelper._resetDebounce();
}

const ledgerFor = async (user) => (await pool.query(
  'SELECT push_type, outcome FROM push_sends WHERE user_id = $1 ORDER BY id', [user.id]
)).rows.map((r) => `${r.push_type}:${r.outcome}`);

const outboxFor = async (user) => (await pool.query(
  'SELECT id, data FROM push_outbox WHERE user_id = $1 ORDER BY id', [user.id]
)).rows;

test('an alarm still at the provider when "I am OK" goes out is followed by the all-clear again, so the all-clear is what the phone keeps', async () => {
  const eve = await mkUser('Eve');
  const kit = await mkUser('Kit');
  await mkPlan(eve, [kit]);
  await addContact(eve, 'Mum', 'mum.eve@example.com', '5550201');
  const phone = await addPhone(kit);
  pushThrough = true;
  const provider = stubProvider({ hold: (m) => m.data.type === 'safety_alert' });
  try {
    const alarm = await call('POST', '/api/safety/alert', { token: eve.token, body: { includeLocation: false } });
    assert.strictEqual(alarm.status, 200, JSON.stringify(alarm.body));
    await until(async () => provider.held.length === 1, 'the alarm at the provider');

    const ok = await call('POST', '/api/safety/alert/cancel', { token: eve.token, body: {} });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    await until(async () => provider.landed.length === 1, 'the all-clear');

    // The alarm lands now, behind the all-clear.
    provider.held.shift().land();
    await until(async () => provider.landed.length === 3, 'the all-clear, again');

    const onPhone = provider.landed.filter((m) => m.token === phone.token);
    assert.deepStrictEqual(onPhone.map((m) => m.data.type),
      ['safety_alert_cancelled', 'safety_alert', 'safety_alert_cancelled'],
      'the phone was left showing the alarm the person had withdrawn');
    assert.strictEqual(new Set(onPhone.map((m) => m.apns.headers['apns-collapse-id'])).size, 1,
      'one slot, so the last to land is what the phone shows');
    assert.ok(pushHelper.SERVER_ONLY_KEYS.includes('alertId'));
    assert.ok(onPhone.every((m) => pushHelper.SERVER_ONLY_KEYS.every((k) => !(k in m.data))),
      'the alert id the server keeps reached a phone');
  } finally {
    stopPushThrough();
  }
});

test('an alarm that lands before the all-clear goes out gets no second all-clear', async () => {
  const flo = await mkUser('Flo');
  const lev = await mkUser('Lev');
  await mkPlan(flo, [lev]);
  await addContact(flo, 'Mum', 'mum.flo@example.com', '5550205');
  const phone = await addPhone(lev);
  pushThrough = true;
  const provider = stubProvider();
  try {
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: flo.token, body: { includeLocation: false } })).status, 200);
    await until(async () => provider.landed.length === 1, 'the alarm');
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: flo.token, body: {} })).status, 200);
    await until(async () => provider.landed.length === 2, 'the all-clear');
    await sleep(150);
    assert.deepStrictEqual(provider.landed.filter((m) => m.token === phone.token).map((m) => m.data.type),
      ['safety_alert', 'safety_alert_cancelled']);
  } finally {
    stopPushThrough();
  }
});

test('an alarm for an alert already stood down is not sent, fresh or from the outbox, and the sweep deletes its row', async () => {
  const fox = await mkUser('Fox');
  const lu = await mkUser('Lu');
  await mkPlan(fox, [lu]);
  await addContact(fox, 'Mum', 'mum.fox@example.com', '5550211');
  const phone = await addPhone(lu);
  const alarm = await call('POST', '/api/safety/alert', { token: fox.token, body: { includeLocation: false } });
  assert.strictEqual(alarm.status, 200);
  await until(async () => (await alertRows(fox))[0].flock_recipient_ids.length === 1, 'the flock leg');
  const captured = pushes.filter((p) => p.userId === lu.id && p.data.type === 'safety_alert').pop();
  assert.ok(captured, 'the flock leg pushed Lu');
  assert.strictEqual(captured.data.alertId, String(alarm.body.alertId), 'each alarm push names its alert, for the server');
  assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: fox.token, body: {} })).status, 200);
  await sleep(50);

  pushThrough = true;
  const provider = stubProvider();
  try {
    // The same push reaching pushHelper only now, after the stand-down.
    const late = await realPushAlways(lu.id, captured.title, captured.body, captured.data);
    assert.strictEqual(late.reason, 'withdrawn', JSON.stringify(late));

    // As a retry queued after the stand-down had cleared the outbox, and as a
    // row queued before alarms named their alert, which asks about the
    // sender's newest alert instead.
    const { alertId, ...unnamed } = captured.data;
    assert.ok(alertId);
    for (const data of [captured.data, unnamed]) {
      await pool.query(
        `INSERT INTO push_outbox (user_id, reason, title, body, data, next_attempt_at, expires_at)
         VALUES ($1, 'retry', $2, $3, $4::jsonb, NOW() - INTERVAL '1 second', NOW() + INTERVAL '10 minutes')`,
        [lu.id, captured.title, captured.body, JSON.stringify(data)]
      );
    }
    await pushHelper.sweepPushOutbox();

    assert.deepStrictEqual(provider.landed.filter((m) => m.token === phone.token), [], 'an alarm reached Lu after "I am OK"');
    assert.deepStrictEqual(await outboxFor(lu), [], 'a row that will never be sent was kept');
    await until(async () => (await ledgerFor(lu)).filter((x) => x === 'safety_alert:withdrawn').length === 3, 'the ledger');
  } finally {
    stopPushThrough();
  }
});

test('an alarm the provider refuses after "I am OK" is not queued for a retry', async () => {
  // The control first: the same refusal while the alert still stands is
  // retried, so the check below cannot pass by nothing being queued at all.
  for (const standDown of [false, true]) {
    const gus = await mkUser('Gus');
    const mo = await mkUser('Mo');
    await mkPlan(gus, [mo]);
    await addContact(gus, 'Mum', `mum.gus.${standDown}@example.com`, '5550221');
    await addPhone(mo);
    pushThrough = true;
    const provider = stubProvider({ hold: (m) => m.data.type === 'safety_alert' });
    try {
      assert.strictEqual((await call('POST', '/api/safety/alert', { token: gus.token, body: { includeLocation: false } })).status, 200);
      await until(async () => provider.held.length === 1, 'the alarm at the provider');
      if (standDown) {
        assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: gus.token, body: {} })).status, 200);
        await until(async () => provider.landed.length === 1, 'the all-clear');
      }
      provider.held.shift().fail();
      await until(async () => (await ledgerFor(mo)).includes('safety_alert:failed'), 'the alarm\'s answer');
      const retries = (await outboxFor(mo)).filter((r) => r.data.type === 'safety_alert');
      if (standDown) {
        assert.deepStrictEqual(retries, [], 'a retry of the withdrawn alarm was queued after the stand-down cleared the outbox');
        await sleep(100);
        assert.deepStrictEqual(provider.landed.map((m) => m.data.type), ['safety_alert_cancelled'],
          'an alarm that never landed needs no second all-clear');
      } else {
        assert.strictEqual(retries.length, 1, 'a failed alarm that still stands is retried');
        await pool.query('DELETE FROM push_outbox WHERE user_id = $1', [mo.id]);
      }
    } finally {
      stopPushThrough();
    }
  }
});

test('a send still running at the 8 second deadline that fails after "I am OK" is not queued for a retry either', async () => {
  const hu = await mkUser('Hu');
  const ned = await mkUser('Ned');
  await mkPlan(hu, [ned]);
  await addContact(hu, 'Mum', 'mum.hu@example.com', '5550231');
  const phone = await addPhone(ned);
  pushThrough = true;
  stubProvider();
  const realSend = firebaseService.sendPushToUser;
  let answer = null;
  // What the per-account send answers at the deadline with a send still out
  // (services/firebaseService.js), and later, what that send came to.
  firebaseService.sendPushToUser = async (userId, title, body, data, opts) => {
    if (data.type !== 'safety_alert') return realSend(userId, title, body, data, opts);
    const settled = new Promise((resolve) => { answer = resolve; });
    return { sent: 0, failed: 1, inFlight: 1, settled };
  };
  try {
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: hu.token, body: { includeLocation: false } })).status, 200);
    await until(async () => typeof answer === 'function', 'the alarm past its deadline');
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: hu.token, body: {} })).status, 200);
    await sleep(50);
    answer({ sent: 0, failed: 1, retryIds: [phone.id] });
    await until(async () => (await ledgerFor(ned)).includes('safety_alert:failed'), 'the late answer');
    assert.deepStrictEqual((await outboxFor(ned)).filter((r) => r.data.type === 'safety_alert'), [],
      'the late answer queued a retry, and a minute later the phone said "needs help" again');
  } finally {
    firebaseService.sendPushToUser = realSend;
    stopPushThrough();
  }
});

test('a late all-clear is not laid over a newer alarm from the same person; anyone that alarm missed still gets it', async () => {
  const ida = await mkUser('Ida');
  const ola = await mkUser('Ola');
  const pip = await mkUser('Pip');
  const flockId = await mkPlan(ida, [ola, pip]);
  await addContact(ida, 'Mum', 'mum.ida@example.com', '5550241');
  const olaPhone = await addPhone(ola);
  const pipPhone = await addPhone(pip);

  // Alert A, stood down.
  assert.strictEqual((await call('POST', '/api/safety/alert', { token: ida.token, body: { includeLocation: false } })).status, 200);
  await until(async () => (await alertRows(ida))[0].flock_recipient_ids.length === 2, 'the first flock leg');
  assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: ida.token, body: {} })).status, 200);
  await until(async () => pushes.some((p) => p.userId === ola.id && p.data.type === 'safety_alert_cancelled'), 'the all-clear');
  const allClear = pushes.filter((p) => p.userId === ola.id && p.data.type === 'safety_alert_cancelled').pop();

  // Pip leaves the plan, and past the hold Ida needs help again: alert B
  // reaches Ola and not Pip.
  await pool.query('UPDATE flock_members SET status = $1 WHERE flock_id = $2 AND user_id = $3', ['declined', flockId, pip.id]);
  await pool.query(`UPDATE emergency_alerts SET created_at = created_at - INTERVAL '130 seconds' WHERE user_id = $1`, [ida.id]);
  const second = await call('POST', '/api/safety/alert', { token: ida.token, body: FIX });
  assert.strictEqual(second.status, 200, JSON.stringify(second.body));
  await until(async () => (await alertRows(ida))[1]?.flock_recipient_ids.length === 1, 'the second flock leg');

  // A's all-clear, as a retry each of them was still owed.
  pushThrough = true;
  const provider = stubProvider();
  try {
    for (const who of [ola, pip]) {
      await pool.query(
        `INSERT INTO push_outbox (user_id, reason, title, body, data, next_attempt_at, expires_at)
         VALUES ($1, 'retry', $2, $3, $4::jsonb, NOW() - INTERVAL '1 second', NOW() + INTERVAL '10 minutes')`,
        [who.id, allClear.title, allClear.body, JSON.stringify({ ...allClear.data, toUserId: String(who.id) })]
      );
    }
    await pushHelper.sweepPushOutbox();
    await sleep(50);
    assert.deepStrictEqual(provider.landed.filter((m) => m.token === olaPhone.token), [],
      '"Ida says they are OK" landed on the alarm Ida raised after it');
    assert.deepStrictEqual(provider.landed.filter((m) => m.token === pipPhone.token).map((m) => m.data.type),
      ['safety_alert_cancelled'], 'Pip holds only the first alarm, and that one is over');
    assert.deepStrictEqual(await outboxFor(ola), [], 'the held-back row was kept');
    await until(async () => (await ledgerFor(ola)).includes('safety_alert_cancelled:superseded'), 'the ledger');
  } finally {
    stopPushThrough();
  }
});

// ===========================================================================
// And an all-clear never lands after a newer alarm that still stands
// ===========================================================================
//
// The mirror of the case above, and the one that can hide a real emergency.
// "I'm OK" more than two minutes after the alert is past every hold, so a new
// SOS goes straight out, and if the all-clear for the OLD alert is still at the
// provider when the new alarm lands, it lands on top of it in the same slot:
// the phone says "says they are OK" while the person needs help.
//
// The provider accepts each message when the test lets it go, so the order
// below is the order each phone received them in. A message is let go only
// once everything before it has finished settling in pushHelper.

// Let one held message land, and give pushHelper's answer to it time to run.
async function letLand(held) {
  held.land();
  await sleep(40);
}

test('an old all-clear that lands after a new alarm is followed by that alarm again, so the phone ends on the emergency', async () => {
  const uma = await mkUser('Uma');
  const vic = await mkUser('Vic');
  await mkPlan(uma, [vic]);
  await addContact(uma, 'Mum', 'mum.uma@example.com', '5550251');
  const phone = await addPhone(vic);
  pushThrough = true;
  let holding = () => false;
  const provider = stubProvider({ hold: (m) => holding(m) });
  try {
    // Alert A goes out and lands.
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: uma.token, body: { includeLocation: false } })).status, 200);
    await until(async () => provider.landed.length === 1, 'the first alarm');

    // More than two minutes on, "I'm OK", and the all-clear sticks at the provider.
    await pool.query(`UPDATE emergency_alerts SET created_at = created_at - INTERVAL '130 seconds' WHERE user_id = $1`, [uma.id]);
    holding = (m) => m.data.type === 'safety_alert_cancelled';
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: uma.token, body: {} })).status, 200);
    await until(async () => provider.held.length === 1, 'the all-clear at the provider');

    // She needs help again, and alert B reaches Vic's phone first.
    const second = await call('POST', '/api/safety/alert', { token: uma.token, body: FIX });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    await until(async () => provider.landed.length === 2, 'the second alarm');
    await sleep(40);

    // Then the old all-clear lands, on top of it.
    await letLand(provider.held.shift());
    await until(async () => provider.landed.length === 4, 'the second alarm, again');
    await sleep(150);

    const onPhone = provider.landed.filter((m) => m.token === phone.token);
    assert.deepStrictEqual(onPhone.map((m) => m.data.type),
      ['safety_alert', 'safety_alert', 'safety_alert_cancelled', 'safety_alert'],
      'the phone was left saying "they are OK" over an emergency that stands');
    const last = onPhone[onPhone.length - 1];
    assert.strictEqual(last.data.latitude, String(FIX.latitude), 'it ends on the alarm that stands, the one with the map');
    assert.strictEqual(new Set(onPhone.map((m) => m.apns.headers['apns-collapse-id'])).size, 1);
    assert.ok(onPhone.every((m) => pushHelper.SERVER_ONLY_KEYS.every((k) => !(k in m.data))));
    assert.strictEqual(pushHelper._openSosSlots(), 0, 'the register drains once the phone shows what is true');
  } finally {
    stopPushThrough();
  }
});

test('two all-clears with a newer alarm between them: the phone still ends on the alarm that stands', async () => {
  // "I'm OK" from this phone and then again from another, both all-clears
  // stuck at the provider, and a new SOS landing between them.
  const wes = await mkUser('Wes');
  const xia = await mkUser('Xia');
  await mkPlan(wes, [xia]);
  await addContact(wes, 'Mum', 'mum.wes@example.com', '5550261');
  const phone = await addPhone(xia);
  pushThrough = true;
  let holding = () => false;
  const provider = stubProvider({ hold: (m) => holding(m) });
  try {
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: wes.token, body: { includeLocation: false } })).status, 200);
    await until(async () => provider.landed.length === 1, 'the first alarm');
    await pool.query(`UPDATE emergency_alerts SET created_at = created_at - INTERVAL '130 seconds' WHERE user_id = $1`, [wes.id]);

    holding = (m) => m.data.type === 'safety_alert_cancelled';
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: wes.token, body: {} })).status, 200);
    await until(async () => provider.held.length === 1, 'the first all-clear at the provider');
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: wes.token, body: {} })).status, 200);
    await until(async () => provider.held.length === 2, 'the second all-clear at the provider');

    assert.strictEqual((await call('POST', '/api/safety/alert', { token: wes.token, body: FIX })).status, 200);
    await until(async () => provider.landed.length === 2, 'the second alarm');
    await sleep(40);

    await letLand(provider.held.shift());
    await letLand(provider.held.shift());
    await until(async () => provider.landed.length === 5, 'the alarm that stands, again');
    await sleep(150);

    const onPhone = provider.landed.filter((m) => m.token === phone.token);
    assert.deepStrictEqual(onPhone.map((m) => m.data.type),
      ['safety_alert', 'safety_alert', 'safety_alert_cancelled', 'safety_alert_cancelled', 'safety_alert']);
    assert.strictEqual(onPhone[onPhone.length - 1].data.latitude, String(FIX.latitude));
    assert.strictEqual(pushHelper._openSosSlots(), 0);
  } finally {
    stopPushThrough();
  }
});

test('an alarm that lands between two all-clears after it was itself stood down is not raised again', async () => {
  // The other half of the same rule: the truth decides, not the kind of push.
  // B was stood down too, so the phone must end on "OK" and nothing may send
  // B's alarm again.
  const yan = await mkUser('Yan');
  const zed = await mkUser('Zed');
  await mkPlan(yan, [zed]);
  await addContact(yan, 'Mum', 'mum.yan@example.com', '5550271');
  const phone = await addPhone(zed);
  pushThrough = true;
  let holding = () => false;
  const provider = stubProvider({ hold: (m) => holding(m) });
  try {
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: yan.token, body: { includeLocation: false } })).status, 200);
    await until(async () => provider.landed.length === 1, 'the first alarm');
    await pool.query(`UPDATE emergency_alerts SET created_at = created_at - INTERVAL '130 seconds' WHERE user_id = $1`, [yan.id]);
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: yan.token, body: {} })).status, 200);
    await until(async () => provider.landed.length === 2, 'the first all-clear');
    await sleep(40);

    // B, stuck at the provider, and "I'm OK" again, stuck too.
    holding = () => true;
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: yan.token, body: FIX })).status, 200);
    await until(async () => provider.held.length === 1, 'the second alarm at the provider');
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: yan.token, body: {} })).status, 200);
    await until(async () => provider.held.length === 2, 'the second all-clear at the provider');

    // The alarm lands, then the all-clear that withdrew it.
    holding = () => false;
    await letLand(provider.held.shift());
    await letLand(provider.held.shift());
    await sleep(200);

    const onPhone = provider.landed.filter((m) => m.token === phone.token);
    assert.deepStrictEqual(onPhone.map((m) => m.data.type),
      ['safety_alert', 'safety_alert_cancelled', 'safety_alert', 'safety_alert_cancelled'],
      'a withdrawn alarm was raised again, or an all-clear was sent that nothing needed');
    assert.strictEqual(pushHelper._openSosSlots(), 0);
  } finally {
    stopPushThrough();
  }
});

test('an older alarm that lands after a newer one that still stands is followed by the newer one again', async () => {
  // Alert A went out without a location and its alarm stuck at the provider;
  // the follow-up F, with the map, landed first. Both stand, and the phone
  // must end on the newest of them, not on the one without the map.
  const abe = await mkUser('Abe');
  const bex = await mkUser('Bex');
  await mkPlan(abe, [bex]);
  await addContact(abe, 'Mum', 'mum.abe@example.com', '5550281');
  const phone = await addPhone(bex);
  pushThrough = true;
  const provider = stubProvider({ hold: (m) => m.data.type === 'safety_alert' && !m.data.latitude });
  try {
    const first = await call('POST', '/api/safety/alert', { token: abe.token, body: { includeLocation: false } });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    await until(async () => provider.held.length === 1, 'the first alarm at the provider');

    const follow = await call('POST', '/api/safety/alert', { token: abe.token, body: { ...FIX, followUpTo: first.body.alertId } });
    assert.strictEqual(follow.status, 200, JSON.stringify(follow.body));
    await until(async () => provider.landed.length === 1, 'the follow-up');
    await sleep(40);

    await letLand(provider.held.shift());
    await until(async () => provider.landed.length === 3, 'the follow-up, again');
    await sleep(150);

    const onPhone = provider.landed.filter((m) => m.token === phone.token);
    assert.deepStrictEqual(onPhone.map((m) => Boolean(m.data.latitude)), [true, false, true],
      'the phone was left on the alarm without the map');
    assert.ok(onPhone.every((m) => m.data.type === 'safety_alert'));
    assert.strictEqual(pushHelper._openSosSlots(), 0);
  } finally {
    stopPushThrough();
  }
});

// ===========================================================================
// Per device, not per person
// ===========================================================================
//
// A push answers once every one of a person's devices has answered, so with
// a phone and a laptop and a provider that is slow for one of them, the order
// the pushes answer in is not the order either device received them in. What
// a device shows last is decided per device, and corrected on that device.

const typesOn = (provider, device) => provider.landed.filter((m) => m.token === device.token).map((m) => m.data.type);

test('two devices: an alarm that reaches the phone after its all-clear is corrected on the phone, although the laptop answered last', async () => {
  const sen = await mkUser('Sen');
  const rec = await mkUser('Rec');
  await mkPlan(sen, [rec]);
  await addContact(sen, 'Mum', 'mum.sen.a@example.com', '5550301');
  const phone = await addPhone(rec);
  const laptop = await addPhone(rec);
  pushThrough = true;
  let holding = (m) => m.data.type === 'safety_alert' && m.token === phone.token;
  const provider = stubProvider({ hold: (m) => holding(m) });
  try {
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: sen.token, body: { includeLocation: false } })).status, 200);
    await until(async () => provider.held.length === 1 && provider.landed.length === 1, 'the alarm on the laptop, held for the phone');

    holding = (m) => (m.data.type === 'safety_alert' && m.token === phone.token)
      || (m.data.type === 'safety_alert_cancelled' && m.token === laptop.token);
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: sen.token, body: {} })).status, 200);
    await until(async () => provider.held.length === 2 && provider.landed.length === 2, 'the all-clear on the phone, held for the laptop');

    // The alarm reaches the phone after the all-clear did, and the laptop's
    // all-clear is the last push to answer.
    holding = () => false;
    await letLand(provider.held.shift());
    await letLand(provider.held.shift());
    await until(async () => typesOn(provider, phone).length === 3, 'the all-clear on the phone, again');
    await sleep(150);

    assert.deepStrictEqual(typesOn(provider, phone), ['safety_alert_cancelled', 'safety_alert', 'safety_alert_cancelled'],
      'the phone was left on the alarm the person had withdrawn');
    assert.deepStrictEqual(typesOn(provider, laptop), ['safety_alert', 'safety_alert_cancelled'],
      'the laptop already showed the all-clear and is not sent it twice');
    assert.strictEqual(pushHelper._openSosSlots(), 0);
  } finally {
    stopPushThrough();
  }
});

test('two devices: an old all-clear that reaches the phone after a new alarm is corrected on the phone, although the laptop answered last', async () => {
  const sen = await mkUser('Sen');
  const rec = await mkUser('Rec');
  await mkPlan(sen, [rec]);
  await addContact(sen, 'Mum', 'mum.sen.b@example.com', '5550302');
  const phone = await addPhone(rec);
  const laptop = await addPhone(rec);
  pushThrough = true;
  let holding = () => false;
  const provider = stubProvider({ hold: (m) => holding(m) });
  try {
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: sen.token, body: { includeLocation: false } })).status, 200);
    await until(async () => provider.landed.length === 2, 'the first alarm on both devices');
    await sleep(40);
    await pool.query(`UPDATE emergency_alerts SET created_at = created_at - INTERVAL '130 seconds' WHERE user_id = $1`, [sen.id]);

    holding = (m) => m.data.type === 'safety_alert_cancelled' && m.token === phone.token;
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: sen.token, body: {} })).status, 200);
    await until(async () => provider.held.length === 1 && provider.landed.length === 3, 'the all-clear on the laptop, held for the phone');

    holding = (m) => (m.data.type === 'safety_alert_cancelled' && m.token === phone.token)
      || (m.data.type === 'safety_alert' && m.token === laptop.token);
    const second = await call('POST', '/api/safety/alert', { token: sen.token, body: FIX });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    await until(async () => provider.held.length === 2 && provider.landed.length === 4, 'the new alarm on the phone, held for the laptop');

    // The old all-clear reaches the phone after the new alarm, and the new
    // alarm's laptop copy is the last push to answer.
    holding = () => false;
    await letLand(provider.held.shift());
    await letLand(provider.held.shift());
    await until(async () => typesOn(provider, phone).length === 4, 'the new alarm on the phone, again');
    await sleep(150);

    const onPhone = provider.landed.filter((m) => m.token === phone.token);
    assert.deepStrictEqual(onPhone.map((m) => m.data.type), ['safety_alert', 'safety_alert', 'safety_alert_cancelled', 'safety_alert'],
      'the phone was left saying they are OK over an alarm that stands');
    assert.strictEqual(onPhone[3].data.latitude, String(FIX.latitude));
    assert.deepStrictEqual(typesOn(provider, laptop), ['safety_alert', 'safety_alert_cancelled', 'safety_alert'],
      'the laptop already showed the new alarm and is not sent it twice');
    assert.strictEqual(pushHelper._openSosSlots(), 0);
  } finally {
    stopPushThrough();
  }
});

// ===========================================================================
// Every all-clear is checked, and a correction does not need a copy in memory
// ===========================================================================

test('the stand-down\'s own all-clear, held up until a newer alarm has landed, is not sent over it', async () => {
  const sen = await mkUser('Sen');
  const rec = await mkUser('Rec');
  await mkPlan(sen, [rec]);
  await addContact(sen, 'Mum', 'mum.sen.c@example.com', '5550303');
  const phone = await addPhone(rec);
  pushThrough = true;
  const provider = stubProvider();
  const realQuery = pool.query;
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  // The stand-down's audience read, stalled until the test lets it go.
  pool.query = function stalled(text, params) {
    if (text === S.SOS_STAND_DOWN_SNAPSHOT_SQL) return gate.then(() => realQuery.call(pool, text, params));
    return realQuery.apply(pool, arguments);
  };
  try {
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: sen.token, body: { includeLocation: false } })).status, 200);
    await until(async () => provider.landed.length === 1, 'the first alarm');
    await realQuery.call(pool, `UPDATE emergency_alerts SET created_at = created_at - INTERVAL '130 seconds' WHERE user_id = $1`, [sen.id]);

    // "I'm OK" commits, and its flock leg sticks on the audience read.
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: sen.token, body: {} })).status, 200);
    // A new, genuine SOS, whose alarm lands and settles.
    const second = await call('POST', '/api/safety/alert', { token: sen.token, body: FIX });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    await until(async () => provider.landed.length === 2, 'the new alarm');
    await until(async () => pushHelper._openSosSlots() === 0, 'the new alarm settled');

    // Now the stand-down's all-clear goes out, and must not land on it.
    release();
    await until(async () => (await ledgerFor(rec)).includes('safety_alert_cancelled:superseded'), 'the all-clear held back');
    await sleep(150);
    assert.deepStrictEqual(typesOn(provider, phone), ['safety_alert', 'safety_alert'],
      'the phone was left saying they are OK over an alarm that stands');
  } finally {
    pool.query = realQuery;
    stopPushThrough();
  }
});

// A statement pushHelper sends, made to fail the next `times` times it is sent.
function failNext(match, times = 1) {
  const realQuery = pool.query;
  let left = times;
  pool.query = function failing(text, params) {
    if (left > 0 && typeof text === 'string' && match(text)) {
      left -= 1;
      return Promise.reject(new Error('connection terminated unexpectedly'));
    }
    return realQuery.apply(pool, arguments);
  };
  return () => { pool.query = realQuery; };
}

test('an all-clear sent without its newer-alarm check is corrected by the newer alarm, rebuilt from the database', async () => {
  const sen = await mkUser('Sen');
  const rec = await mkUser('Rec');
  await mkPlan(sen, [rec]);
  await addContact(sen, 'Mum', 'mum.sen.d@example.com', '5550304');
  const phone = await addPhone(rec);
  pushThrough = true;
  const provider = stubProvider();
  let restore = () => {};
  try {
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: sen.token, body: { includeLocation: false } })).status, 200);
    await until(async () => provider.landed.length === 1, 'the first alarm');
    await pool.query(`UPDATE emergency_alerts SET created_at = created_at - INTERVAL '130 seconds' WHERE user_id = $1`, [sen.id]);
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: sen.token, body: {} })).status, 200);
    await until(async () => provider.landed.length === 2, 'the all-clear');
    const allClear = pushes.filter((p) => p.userId === rec.id && p.data.type === 'safety_alert_cancelled').pop();
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: sen.token, body: FIX })).status, 200);
    await until(async () => provider.landed.length === 3, 'the new alarm');
    await until(async () => pushHelper._openSosSlots() === 0, 'the new alarm settled');
    // What a restart forgets: nothing in memory holds the new alarm now.
    if (typeof pushHelper._forgetSosContent === 'function') pushHelper._forgetSosContent();

    // The old all-clear, still owed to the phone, is released while the check
    // that would hold it back cannot read the database, so it goes out.
    await pool.query(
      `INSERT INTO push_outbox (user_id, reason, title, body, data, next_attempt_at, expires_at)
       VALUES ($1, 'retry', $2, $3, $4::jsonb, NOW() - INTERVAL '1 second', NOW() + INTERVAL '10 minutes')`,
      [rec.id, allClear.title, allClear.body, JSON.stringify(allClear.data)]
    );
    restore = failNext((sql) => sql.includes('AS superseded'));
    await pushHelper.sweepPushOutbox();
    await until(async () => typesOn(provider, phone).length === 5, 'the new alarm, again');
    await sleep(150);

    const onPhone = provider.landed.filter((m) => m.token === phone.token);
    assert.deepStrictEqual(onPhone.map((m) => m.data.type),
      ['safety_alert', 'safety_alert_cancelled', 'safety_alert', 'safety_alert_cancelled', 'safety_alert']);
    const last = onPhone[4];
    assert.strictEqual(last.notification.title, 'Sen needs help');
    assert.strictEqual(last.data.latitude, String(FIX.latitude), 'the rebuilt alarm carries the location the alert stored');
    assert.strictEqual(last.data.toUserId, String(rec.id));
    assert.ok(!('alertId' in last.data));
  } finally {
    restore();
    stopPushThrough();
  }
});

test('an alarm sent without its stood-down check is corrected by an all-clear rebuilt from the database', async () => {
  const sen = await mkUser('Sen');
  const rec = await mkUser('Rec');
  await mkPlan(sen, [rec]);
  await addContact(sen, 'Mum', 'mum.sen.e@example.com', '5550305');
  const phone = await addPhone(rec);
  pushThrough = true;
  const provider = stubProvider();
  let restore = () => {};
  try {
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: sen.token, body: { includeLocation: false } })).status, 200);
    await until(async () => provider.landed.length === 1, 'the alarm');
    const alarm = pushes.filter((p) => p.userId === rec.id && p.data.type === 'safety_alert').pop();
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: sen.token, body: {} })).status, 200);
    await until(async () => provider.landed.length === 2, 'the all-clear');
    await until(async () => pushHelper._openSosSlots() === 0, 'the all-clear settled');

    // A retry of the alarm, released while the stood-down check cannot read.
    await pool.query(
      `INSERT INTO push_outbox (user_id, reason, title, body, data, next_attempt_at, expires_at)
       VALUES ($1, 'retry', $2, $3, $4::jsonb, NOW() - INTERVAL '1 second', NOW() + INTERVAL '10 minutes')`,
      [rec.id, alarm.title, alarm.body, JSON.stringify(alarm.data)]
    );
    restore = failNext((sql) => sql.includes('AS stood_down'));
    await pushHelper.sweepPushOutbox();
    await until(async () => typesOn(provider, phone).length === 4, 'the all-clear, again');
    await sleep(150);

    const onPhone = provider.landed.filter((m) => m.token === phone.token);
    assert.deepStrictEqual(onPhone.map((m) => m.data.type),
      ['safety_alert', 'safety_alert_cancelled', 'safety_alert', 'safety_alert_cancelled']);
    assert.strictEqual(onPhone[3].notification.title, 'Sen says they are OK');
    assert.strictEqual(onPhone[3].data.toUserId, String(rec.id));
  } finally {
    restore();
    stopPushThrough();
  }
});

test('a lock-screen check that cannot read the database tries again, and then corrects the phone', async () => {
  const sen = await mkUser('Sen');
  const rec = await mkUser('Rec');
  await mkPlan(sen, [rec]);
  await addContact(sen, 'Mum', 'mum.sen.f@example.com', '5550306');
  const phone = await addPhone(rec);
  if (typeof pushHelper._setSosRecheckDelays === 'function') pushHelper._setSosRecheckDelays([60, 120, 240]);
  pushThrough = true;
  const provider = stubProvider({ hold: (m) => m.data.type === 'safety_alert' });
  let restore = () => {};
  try {
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: sen.token, body: { includeLocation: false } })).status, 200);
    await until(async () => provider.held.length === 1, 'the alarm at the provider');
    assert.strictEqual((await call('POST', '/api/safety/alert/cancel', { token: sen.token, body: {} })).status, 200);
    await until(async () => provider.landed.length === 1, 'the all-clear');

    // The alarm lands behind the all-clear, and the first check cannot read.
    restore = failNext((sql) => sql.includes('AS standing'));
    await letLand(provider.held.shift());
    await until(async () => typesOn(provider, phone).length === 3, 'the all-clear, again');
    await sleep(150);
    assert.deepStrictEqual(typesOn(provider, phone), ['safety_alert_cancelled', 'safety_alert', 'safety_alert_cancelled']);
    assert.strictEqual(pushHelper._openSosSlots(), 0);
  } finally {
    restore();
    if (typeof pushHelper._setSosRecheckDelays === 'function') pushHelper._setSosRecheckDelays(null);
    stopPushThrough();
  }
});

// ===========================================================================
// The two-minute hold is for an older build's chase and nothing else
// ===========================================================================

test('after a 502 there is no chase to hold off: "I am OK" and then a fresh press with a fix goes out', async () => {
  // The app starts a chase only on a 200, and a 502 means no contact's email
  // was accepted, so no chase can exist; the failed claim's backdated time met
  // the two-minute hold anyway and the press was refused for 59 seconds.
  const ada = await mkUser('Ada');
  const ben = await mkUser('Ben');
  await mkPlan(ada, [ben]);
  await addContact(ada, 'Mum', 'mum.ada.502@example.com', '5550311');
  const realSend = emailService.sendEmail;
  emailService.sendEmail = async () => ({ sent: false, error: 'provider down' });
  try {
    const first = await call('POST', '/api/safety/alert', { token: ada.token, body: { includeLocation: false } });
    assert.strictEqual(first.status, 502, JSON.stringify(first.body));
    await until(async () => (await alertRows(ada))[0].flock_recipient_ids.length === 1, 'the flock leg');
  } finally {
    emailService.sendEmail = realSend;
  }
  const ok = await call('POST', '/api/safety/alert/cancel', { token: ada.token, body: {} });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const again = await call('POST', '/api/safety/alert', { token: ada.token, body: FIX });
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));
});

test('the current app marks a fresh press, and a marked press with a fix after "I am OK" waits out only the floor', async () => {
  // A genuine re-press from a build that tags its chase with followUpTo cannot
  // be that chase, so the two-minute hold does not apply to it.
  const cal = await mkUser('Cal');
  await addContact(cal, 'Mum', 'mum.cal.fresh@example.com', '5550312');
  assert.strictEqual((await call('POST', '/api/safety/alert', { token: cal.token, body: { includeLocation: false } })).status, 200);
  await standDownAndAge(cal, 70);
  const marked = await call('POST', '/api/safety/alert', { token: cal.token, body: { ...FIX, fresh: true } });
  assert.strictEqual(marked.status, 200, JSON.stringify(marked.body));

  // Unmarked, the same press keeps the hold an older build needs.
  const dee = await mkUser('Dee');
  await addContact(dee, 'Mum', 'mum.dee.fresh@example.com', '5550313');
  assert.strictEqual((await call('POST', '/api/safety/alert', { token: dee.token, body: { includeLocation: false } })).status, 200);
  await standDownAndAge(dee, 70);
  const unmarked = await call('POST', '/api/safety/alert', { token: dee.token, body: FIX });
  assert.strictEqual(unmarked.status, 429, JSON.stringify(unmarked.body));
  assert.strictEqual(unmarked.body.withdrawn, true);
});

test('a marker that is not exactly true is no marker', async () => {
  for (const [i, fresh] of [['1', 'true'], ['2', 1], ['3', 'yes']]) {
    const eli = await mkUser(`Eli${i}`);
    await addContact(eli, 'Mum', `mum.eli${i}.fresh@example.com`, `555032${i}`);
    assert.strictEqual((await call('POST', '/api/safety/alert', { token: eli.token, body: { includeLocation: false } })).status, 200);
    await standDownAndAge(eli, 70);
    const res = await call('POST', '/api/safety/alert', { token: eli.token, body: { ...FIX, fresh } });
    assert.strictEqual(res.status, 429, `${JSON.stringify(fresh)}: ${JSON.stringify(res.body)}`);
  }
});
