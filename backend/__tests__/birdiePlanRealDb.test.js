// Run: node --test  (from backend/)
//
// THE GROUP'S PLAN, ON A REAL DATABASE (services/birdiePlan.js).
//
// Birdie asked from inside a flock reads that flock's plan, and only for an
// accepted member of it: the gate is the JOIN on the asker's own membership in
// the plan statement, so it is pinned here on Postgres rather than on a fake
// that answers whatever it is told. Also pinned: the going count is the one
// the flock screen shows (a member the asker blocked is not counted, a guest
// who said in is, a guest taken down or who said out is not), the picks are
// the screen's tally (a non-member's vote row counts for nothing), a locked
// plan carries its venue and no picks, and a plan that is over has none.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('birdiePlanRealDb');
const DB_NAME = 'flock_birdie_plan_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-birdie-plan';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;

let pg;
let pool;
let dataDir;
let loadFlockPlan;
let seq = 0;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-birdie-plan-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'birdiePlanRealDb', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  ({ loadFlockPlan } = require('../services/birdiePlan'));
  await seedFridayNight();
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'birdiePlanRealDb');
});

async function mkUser(name) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified) VALUES ($1, 'x', $2, true) RETURNING id`,
    [`plan${seq}-${Date.now()}@birdie.test`, name]
  );
  return rows[0].id;
}
const member = (flockId, userId, status = 'accepted') => pool.query(
  'INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, $3)', [flockId, userId, status]
);
const vote = (flockId, userId, venue, placeId) => pool.query(
  'INSERT INTO venue_votes (flock_id, user_id, venue_name, venue_id) VALUES ($1, $2, $3, $4)', [flockId, userId, venue, placeId]
);
const guest = async (flockId, name, status, hidden = false) => (await pool.query(
  'INSERT INTO guest_rsvps (flock_id, name, status, is_hidden) VALUES ($1, $2, $3, $4) RETURNING id', [flockId, name, status, hidden]
)).rows[0].id;

// The demo's "Friday night": six going (five accepted members the asker can
// see, and Riley from the share link), voting on three picks.
let flockId;
let alex;
let dana;
let ivy;
async function seedFridayNight() {
  alex = await mkUser('Alex Chen');
  const [jordan, priya, leo, sam, bo] = [await mkUser('Jordan Avery'), await mkUser('Priya Shah'), await mkUser('Leo Martin'), await mkUser('Sam Rivera'), await mkUser('Bo Hart')];
  dana = await mkUser('Dana Mercer');
  ivy = await mkUser('Ivy Cole');
  flockId = (await pool.query(`INSERT INTO flocks (name, creator_id, status) VALUES ('Friday night', $1, 'planning') RETURNING id`, [alex])).rows[0].id;
  for (const u of [alex, jordan, priya, leo, sam, bo]) await member(flockId, u);
  await member(flockId, ivy, 'invited');
  await guest(flockId, 'Riley', 'in');
  await guest(flockId, 'Taken Down', 'in', true);
  await guest(flockId, 'Not Coming', 'out');
  await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [alex, bo]);
  for (const u of [jordan, leo, alex]) await vote(flockId, u, 'Larkspur Tap', 'demo-larkspur-tap');
  await vote(flockId, priya, 'Wren & Barrel', 'demo-wren-barrel');
  await vote(flockId, sam, "Fennick's", 'demo-fennicks');
  // A vote row from someone who is not in the plan counts for nothing.
  await vote(flockId, dana, 'Thistle & Crust', 'demo-thistle-crust');
}

test('a member gets the screen\'s going count and the vote\'s picks with their counts', async () => {
  const plan = await loadFlockPlan(flockId, alex);
  assert.strictEqual(plan.going, 6);
  assert.strictEqual(plan.locked, null);
  assert.strictEqual(plan.venueSoFar, null);
  // The leader first; the tally puts no order on a tie, so the two 1-vote
  // picks are compared as a set.
  assert.deepStrictEqual(plan.picks[0], { name: 'Larkspur Tap', placeId: 'demo-larkspur-tap', votes: 3 });
  const byName = (a, b) => a.name.localeCompare(b.name);
  assert.deepStrictEqual(plan.picks.slice(1).sort(byName), [
    { name: "Fennick's", placeId: 'demo-fennicks', votes: 1 },
    { name: 'Wren & Barrel', placeId: 'demo-wren-barrel', votes: 1 },
  ]);
});

test('someone who is not an accepted member gets nothing: not a stranger, not an invitee', async () => {
  assert.strictEqual(await loadFlockPlan(flockId, dana), null);
  assert.strictEqual(await loadFlockPlan(flockId, ivy), null);
  assert.strictEqual(await loadFlockPlan(flockId + 1000, alex), null, 'a flock that does not exist');
});

test('a locked plan carries its venue and no picks; a plan that is over carries nothing', async () => {
  await pool.query(`UPDATE flocks SET status = 'confirmed', venue_name = 'Larkspur Tap', venue_id = 'demo-larkspur-tap' WHERE id = $1`, [flockId]);
  assert.deepStrictEqual(await loadFlockPlan(flockId, alex), {
    going: 6, locked: { name: 'Larkspur Tap', placeId: 'demo-larkspur-tap' }, venueSoFar: null, picks: [],
  });
  // Planning again, with the venue still set: it is the plan's venue so far.
  await pool.query(`UPDATE flocks SET status = 'planning' WHERE id = $1`, [flockId]);
  const soFar = await loadFlockPlan(flockId, alex);
  assert.deepStrictEqual(soFar.venueSoFar, { name: 'Larkspur Tap', placeId: 'demo-larkspur-tap' });
  assert.strictEqual(soFar.picks.length, 3);
  for (const over of ['completed', 'cancelled']) {
    await pool.query('UPDATE flocks SET status = $2 WHERE id = $1', [flockId, over]);
    assert.strictEqual(await loadFlockPlan(flockId, alex), null, over);
  }
  await pool.query(`UPDATE flocks SET status = 'planning', venue_name = NULL, venue_id = NULL WHERE id = $1`, [flockId]);
});
