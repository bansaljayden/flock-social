'use strict';
// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE BACK HALF OF THE PRODUCT, WALKED ONCE, AGAINST A REAL POSTGRES
// ---------------------------------------------------------------------------
//
// planning -> confirmed -> completed -> attendance -> reliability -> history.
//
// Every one of those arrows shipped and was individually tested. The chain had
// never been walked, because the first arrow was missing: the only code that
// ever wrote 'confirmed' was a socket event the frontend never emitted, so in
// production every flock ever created sat at 'planning' forever. Everything
// downstream was unreachable rather than broken, which is why nothing went red:
// the slide-to-complete bar renders only on a confirmed flock, attendance is
// refused on anything but a completed one, reliability is only written by
// attendance, and GET /api/flocks/history lists only completed or cancelled
// flocks. One missing call at the top made the bottom five stages dead code.
//
// So this file walks it, once, in order, with the real routes on a real
// database. Not a fake pool: the point of the exercise is that the SQL these
// stages hand each other actually composes, and a scripted pool would be
// asserting the composition it was written to prove.
//
// The two clocks matter and are set deliberately:
//   * event_time is 20 hours ago, so the plan is past the sweep's 12-hour grace
//     window and past the `ev.started` predicate the reliability tally uses.
//   * two accepted members, because the tally ignores flocks with fewer than
//     two (a solo flock could otherwise farm a perfect score).
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

// Synchronous, and set BEFORE config/database is required anywhere, because
// that module builds its Pool from DATABASE_URL at require time. Everything
// that touches the database in this file is required lazily inside
// test.before() so it binds to this, and never to backend/.env's Railway URL.
const PG_PORT = pickEmbeddedPgPort('flockLifecycle');
const DB_NAME = 'flock_lifecycle_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
process.env.PGSSLMODE = 'disable';
process.env.JWT_SECRET = 'test-secret-for-flock-lifecycle-walk';
process.env.NODE_ENV = 'test';

let pg;
let pool;
let dataDir;
let server;
let base;
let alice;
let bob;
let flockId;
let runFlockCompletionSweep;

/** Minimal JSON client. supertest is not a dependency of this repo. */
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
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const flockRow = async () => (await pool.query('SELECT * FROM flocks WHERE id = $1', [flockId])).rows[0];

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-lifecycle-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'flockLifecycle', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  // The real runner over the real chain: these routes read columns that only
  // exist because of migrations, so a schema built by hand here would be
  // testing a database production does not have.
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const { signUserToken } = require('../middleware/auth');
  const mkUser = async (email, name) => {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password, name, email_verified) VALUES ($1, 'x', $2, true) RETURNING *`,
      [email, name]
    );
    return { ...rows[0], token: signUserToken(rows[0]) };
  };
  alice = await mkUser('alice@lifecycle.test', 'Alice');
  bob = await mkUser('bob@lifecycle.test', 'Bob');

  // A plan for a night that is already over, still sitting in 'planning' —
  // which is the state of every flock in production before this drop.
  const { rows } = await pool.query(
    `INSERT INTO flocks (name, creator_id, venue_name, venue_address, event_time, status)
     VALUES ('Last Night', $1, 'Kome', '10 Main St', NOW() - INTERVAL '20 hours', 'planning')
     RETURNING id`,
    [alice.id]
  );
  flockId = rows[0].id;
  for (const u of [alice, bob]) {
    await pool.query(
      `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')`,
      [flockId, u.id]
    );
  }

  const app = express();
  app.use(express.json());
  app.use('/api/flocks', require('../routes/flocks'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  ({ runFlockCompletionSweep } = require('../services/flockSweep'));
});

test.after(async () => {
  await new Promise((r) => (server ? server.close(r) : r()));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn('[flockLifecycle] could not remove %s: %s', dataDir, err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 0 — where every flock in production actually is
// ═══════════════════════════════════════════════════════════════════════════

test('a flock with a venue is still only "planning", and history is empty', async () => {
  const row = await flockRow();
  assert.equal(row.status, 'planning');
  assert.equal(row.venue_name, 'Kome');
  // The exact pair the walkthrough observed at runtime: a venue saved, a status
  // that never moved. Saving a venue is not confirming a plan.
  const history = await call('GET', '/api/flocks/history', { token: alice.token });
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.flocks ?? history.body, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 1 — the call the Confirm button now makes
// ═══════════════════════════════════════════════════════════════════════════

test('the host confirming the plan writes status confirmed', async () => {
  // setFlockStatus(flockId, 'confirmed') in frontend/src/services/api.js is
  // exactly this request. It always worked. Nothing ever sent it.
  const res = await call('PUT', `/api/flocks/${flockId}`, {
    token: alice.token, body: { status: 'confirmed' },
  });
  assert.equal(res.status, 200);
  assert.equal((await flockRow()).status, 'confirmed');
});

test('a member who is not the host cannot confirm', async () => {
  const res = await call('PUT', `/api/flocks/${flockId}`, {
    token: bob.token, body: { status: 'planning' },
  });
  assert.equal(res.status, 403);
  assert.equal((await flockRow()).status, 'confirmed', 'and the row did not move');
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 2 — the sweep, which is the only thing in the product that moves a
// flock through time
// ═══════════════════════════════════════════════════════════════════════════

test('the sweep completes a confirmed flock whose night is over', async () => {
  const moved = await runFlockCompletionSweep();
  assert.ok(moved >= 1);
  assert.equal((await flockRow()).status, 'completed');
});

test('running it again moves nothing', async () => {
  assert.equal(await runFlockCompletionSweep(), 0);
  assert.equal((await flockRow()).status, 'completed');
});

test('a confirmed flock with no time on it is left alone', async () => {
  const { rows } = await pool.query(
    `INSERT INTO flocks (name, creator_id, status, event_time) VALUES ('No Time Set', $1, 'confirmed', NULL) RETURNING id`,
    [alice.id]
  );
  const { rows: soon } = await pool.query(
    `INSERT INTO flocks (name, creator_id, status, event_time)
     VALUES ('Tonight', $1, 'confirmed', NOW() - INTERVAL '1 hour') RETURNING id`,
    [alice.id]
  );
  assert.equal(await runFlockCompletionSweep(), 0);
  const after = await pool.query('SELECT id, status FROM flocks WHERE id = ANY($1)', [[rows[0].id, soon[0].id]]);
  // No event_time means no night to be past, and an hour after the start is
  // the middle of the night, not the end of it.
  for (const r of after.rows) assert.equal(r.status, 'confirmed');
  await pool.query('DELETE FROM flocks WHERE id = ANY($1)', [[rows[0].id, soon[0].id]]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3 — attendance, which only a completed flock accepts
// ═══════════════════════════════════════════════════════════════════════════

test('the host marks who showed up, and reliability scores are written', async () => {
  const res = await call('POST', `/api/flocks/${flockId}/attendance`, {
    token: alice.token,
    body: { attendance: [{ userId: alice.id, attended: true }, { userId: bob.id, attended: false }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);

  const { rows } = await pool.query(
    'SELECT id, reliability_score, total_plans_joined, total_plans_attended FROM users WHERE id = ANY($1) ORDER BY id',
    [[alice.id, bob.id]]
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  // The two ends of the scale, from the same night. Before this chain could be
  // walked, no account in the product had ever had either number written.
  assert.equal(Number(byId[alice.id].reliability_score), 100);
  assert.equal(Number(byId[bob.id].reliability_score), 0);
  assert.equal(Number(byId[alice.id].total_plans_attended), 1);
  assert.equal(Number(byId[bob.id].total_plans_attended), 0);
});

test('attendance is refused on a flock that is not completed', async () => {
  const { rows } = await pool.query(
    `INSERT INTO flocks (name, creator_id, status) VALUES ('Still Planning', $1, 'planning') RETURNING id`,
    [alice.id]
  );
  await pool.query(`INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')`, [rows[0].id, alice.id]);
  const res = await call('POST', `/api/flocks/${rows[0].id}/attendance`, {
    token: alice.token, body: { attendance: [{ userId: alice.id, attended: true }] },
  });
  assert.equal(res.status, 400);
  await pool.query('DELETE FROM flocks WHERE id = $1', [rows[0].id]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 4 — the Past screen, whose empty state promised this would happen
// ═══════════════════════════════════════════════════════════════════════════

test('the finished night is in history for both people who were there', async () => {
  for (const u of [alice, bob]) {
    const res = await call('GET', '/api/flocks/history', { token: u.token });
    assert.equal(res.status, 200);
    const list = res.body.flocks ?? res.body;
    assert.equal(list.length, 1, `${u.name} should see exactly the one finished flock`);
    assert.equal(list[0].id, flockId);
    assert.equal(list[0].status, 'completed');
    assert.equal(list[0].venue_name, 'Kome');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 5 — the owner's Overview reading the walk back
// ═══════════════════════════════════════════════════════════════════════════
//
// The money hub's People figures are five statements over the same tables this
// walk wrote (services/moneyHub.js, PEOPLE). The suite beside it proves their
// wording against a scripted pool; this proves they count what the routes
// really leave behind, on the real schema, with the naive UTC columns read in
// New York days.

test('the Overview counts this walk as people: signups by New York day, first weeks, the active, the plan', async () => {
  const moneyHub = require('../services/moneyHub');
  const now = new Date();
  const naive = `($1::timestamptz AT TIME ZONE 'UTC')`;
  const mk = async (email, { role = 'user', banned = false, ageDays = 0, at = null } = {}) => {
    const createdAt = at || new Date(now.getTime() - ageDays * 86400000);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password, name, role, is_banned, created_at)
       VALUES ($2, 'x', 'Fixture', $3, $4, ${naive}) RETURNING id`,
      [createdAt, email, role, banned]
    );
    return { id: rows[0].id, createdAt };
  };
  // Signed up ten days ago and made a plan on day two: a first week that
  // started something, inside the 8 to 37 day group.
  const carol = await mk('carol@lifecycle.test', { ageDays: 10 });
  await pool.query(
    `INSERT INTO flocks (name, creator_id, status, created_at) VALUES ('Carol Day Two', $2, 'planning', ${naive})`,
    [new Date(carol.createdAt.getTime() + 2 * 86400000), carol.id]
  );
  // In the group, did nothing.
  await mk('dave@lifecycle.test', { ageDays: 20 });
  // Too old for the group, whatever she did.
  const erin = await mk('erin@lifecycle.test', { ageDays: 45 });
  await pool.query(
    `INSERT INTO flocks (name, creator_id, status, created_at) VALUES ('Erin Early', $2, 'planning', ${naive})`,
    [new Date(erin.createdAt.getTime() + 86400000), erin.id]
  );
  // Not people: a venue owner and a banned account, both new today.
  await mk('venue@lifecycle.test', { role: 'venue_owner' });
  await mk('banned@lifecycle.test', { banned: true });
  // Half an hour before the New York midnight that began the day before
  // yesterday: 11:30 PM three days back in New York, and already the next
  // date in UTC. It belongs on the New York day.
  const twoDaysAgo = moneyHub.ymdIn(moneyHub.HUB_TZ, new Date(now.getTime() - 2 * 86400000));
  const evening = new Date(moneyHub.__test.zonedMidnightMs(twoDaysAgo, moneyHub.HUB_TZ) - 30 * 60000);
  await mk('evening@lifecycle.test', { at: evening });

  const p = await moneyHub.readPeople(pool, now);
  assert.equal(p.status, 'ok', p.reason);
  const on = (ymd) => (p.signups.days.find((d) => d.day === ymd) || { n: null }).n;
  const eveningDay = moneyHub.ymdIn(moneyHub.HUB_TZ, evening);
  const eveningUtcDay = evening.toISOString().slice(0, 10);
  assert.notEqual(eveningDay, eveningUtcDay, 'the fixture must straddle midnight to prove anything');
  assert.equal(on(eveningDay), 1, 'a New York evening counts on its New York day');
  assert.equal(on(eveningUtcDay), 0, 'and not on the UTC date it already was');
  // Alice and Bob, Carol, and the evening account: the venue owner, the banned
  // account and the two older than the fortnight are not in the bars.
  assert.equal(p.signups.days.reduce((s, d) => s + d.n, 0), 4);
  assert.equal(p.signups.last7, 3);
  assert.equal(p.signups.prior7, 1);
  // Carol and Dave are the group; Carol started something in her first week.
  assert.equal(p.activation.cohort, 2);
  assert.equal(p.activation.activated, 1);
  assert.equal(p.activation.percent, null, 'two accounts is under the floor for a share');
  // Alice made the plan and both accepted it this week; Carol's plan was eight
  // days ago.
  assert.deepEqual(p.active, { last7: 2, prior7: 1 });
  // The one walked plan: made this week, its night passed this week, and it
  // had been confirmed (the sweep has since completed it).
  assert.equal(p.plans.madeLast7, 1);
  assert.equal(p.plans.madePrior7, 1);
  assert.equal(p.plans.passedLast7, 1);
  assert.equal(p.plans.confirmedLast7, 1);
  assert.equal(p.plans.guestAnswersLast7, 0);
});
