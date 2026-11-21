'use strict';
// ---------------------------------------------------------------------------
// SETTING THE HARVESTED VENUES' CURVES ASIDE, AND PUTTING THEM BACK.
//
// scripts/ml/setAsideHarvestedCurves.js (2026-11-21) swaps ml_venue_baselines
// for a copy without the harvested venues' curves and keeps the old table whole
// under another name, because the collector's hourly recent-deviation rebuild
// reads the whole table and the harvest had made it nine tenths harvested
// curves. Pinned here, against a real migrated Postgres: the dry run writes
// nothing; a lock it cannot get in time leaves everything as it was; the swap
// keeps every other place's slots value for value, under the same index and
// key names, with the same defaults, and keeps every old row under the new
// name; a second swap refuses; and the restore puts back whole curves only for
// places the live table holds none for.
//
// Run: node --test __tests__/setAsideHarvestedCurves.test.js  (from backend/)
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('setAsideHarvestedCurves');
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_setaside_test`;
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-set-aside';

const { migrate } = require('../db/migrate');
const { setAside, restore, LIVE, SET_ASIDE } = require('../scripts/ml/setAsideHarvestedCurves');

let pg;
let pool;
let dataDir;
const quiet = () => {};

async function venue(place, status) {
  await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude, venue_category,
                            timezone, is_active, besttime_status)
     VALUES ($1, $2, $1, 'philly', 39.95, -75.16, 'bar', 'America/New_York', $3, $4)`,
    [place, 'bt_' + place, status !== 'harvested', status]);
}

async function curve(place, value, source = 'collected') {
  await pool.query(
    `INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source, updated_at)
     SELECT $1, d, h, $2, $3, NOW() - interval '1 day' FROM generate_series(0, 6) d, generate_series(0, 23) h`,
    [place, value, source]);
}

const rowsOf = async (table) => (await pool.query(
  `SELECT google_place_id, day_of_week, hour, baseline, source, updated_at FROM ${table} ORDER BY 1, 2, 3`)).rows;
const indexNames = async (table) => (await pool.query(
  'SELECT indexname FROM pg_indexes WHERE tablename = $1', [table])).rows.map((r) => r.indexname).sort();
const exists = async (name) => (await pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [name])).rows[0].present;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-setaside-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'setAsideHarvestedCurves', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_setaside_test');
  pool = new Pool({ connectionString: CONN });
  await migrate(pool);
  await venue('ChIJsetAsideLive1', 'found');
  await venue('ChIJsetAsideLive2', null);
  await venue('ChIJsetAsideHarv1', 'harvested');
  await venue('ChIJsetAsideHarv2', 'harvested');
  await curve('ChIJsetAsideLive1', 40);
  await curve('ChIJsetAsideLive2', 55, 'google');
  await curve('ChIJsetAsideHarv1', 30);
  await curve('ChIJsetAsideHarv2', 20);
  // A place no venue row names stays live, as everything did before.
  await curve('ChIJsetAsideNoVenue', 10);
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'setAsideHarvestedCurves');
});

test('the dry run counts the slots it would keep and writes nothing', async () => {
  const before = await rowsOf(LIVE);
  const r = await setAside(pool, { log: quiet });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.total, 5 * 168);
  assert.equal(r.kept, 3 * 168);
  assert.deepEqual(await rowsOf(LIVE), before);
  assert.equal(await exists(SET_ASIDE), false);
});

test('a lock it cannot get in time leaves everything as it was', async () => {
  const before = await rowsOf(LIVE);
  // An open write holds a table's ROW EXCLUSIVE lock, which SHARE waits on:
  // first on the curves, then on the venues, whose statuses decide the copy.
  for (const write of [
    `UPDATE ${LIVE} SET baseline = baseline WHERE google_place_id = 'ChIJsetAsideLive1' AND day_of_week = 0 AND hour = 0`,
    "UPDATE ml_venues SET besttime_status = besttime_status WHERE google_place_id = 'ChIJsetAsideHarv1'",
  ]) {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(write);
      const t0 = Date.now();
      await assert.rejects(setAside(pool, { commit: true, log: quiet }), (err) => err.code === '55P03', write);
      assert.ok(Date.now() - t0 < 15000, 'it waited past its lock timeout');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }
  assert.deepEqual(await rowsOf(LIVE), before);
  assert.equal(await exists(SET_ASIDE), false);
  assert.equal(await exists('ml_venue_baselines_keep'), false);
});

test('the swap keeps every other place\'s slots under the same names and keeps the old table whole', async () => {
  const before = await rowsOf(LIVE);
  const namesBefore = await indexNames(LIVE);
  assert.ok(namesBefore.includes('ml_venue_baselines_pkey') && namesBefore.includes('idx_ml_baselines_place_dow_hour_cover'));
  const r = await setAside(pool, { commit: true, log: quiet });
  assert.equal(r.ok, true);
  assert.deepEqual(await rowsOf(LIVE), before.filter((x) => !x.google_place_id.startsWith('ChIJsetAsideHarv')));
  assert.deepEqual(await rowsOf(SET_ASIDE), before);
  assert.deepEqual(await indexNames(LIVE), namesBefore);
  assert.deepEqual(await indexNames(SET_ASIDE), namesBefore.map((n) => `${n}_set_aside`).sort());
  const { rows: [pk] } = await pool.query(
    "SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'", [LIVE]);
  assert.equal(pk.conname, 'ml_venue_baselines_pkey');
  // The key is a key (the rebuild's statements rely on it) and the defaults survive.
  await pool.query(`INSERT INTO ${LIVE} (google_place_id, day_of_week, hour, baseline) VALUES ('ChIJsetAsideLive1', 0, 0, 41)
                    ON CONFLICT (google_place_id, day_of_week, hour) DO UPDATE SET baseline = EXCLUDED.baseline`);
  await assert.rejects(pool.query(
    `INSERT INTO ${LIVE} (google_place_id, day_of_week, hour, baseline) VALUES ('ChIJsetAsideLive1', 0, 0, 42)`),
  (err) => err.code === '23505');
  await pool.query(`INSERT INTO ${LIVE} (google_place_id, day_of_week, hour, baseline) VALUES ('ChIJsetAsideDefaults', 0, 0, 5)`);
  const { rows: [d] } = await pool.query(
    `SELECT source, updated_at IS NOT NULL AS dated FROM ${LIVE} WHERE google_place_id = 'ChIJsetAsideDefaults'`);
  assert.deepEqual([d.source, d.dated], ['collected', true]);
  const again = await setAside(pool, { commit: true, log: quiet });
  assert.equal(again.ok, false);
  assert.match(again.refused, /already exists/);
});

test('the restore puts back whole curves only for places the live table holds none for', async () => {
  // Harv2 has a live curve again (rebuilt after a promotion, say): it keeps that one.
  await curve('ChIJsetAsideHarv2', 77);
  // It takes the corpus write lock a rebuild holds, so it waits for one.
  const { ML_CORPUS_LOCK_SQL } = require('../scripts/ml/config');
  const holder = await pool.connect();
  let settled = false;
  let pending;
  try {
    await holder.query('BEGIN');
    await holder.query(ML_CORPUS_LOCK_SQL);
    pending = restore(pool, { log: quiet }).then((x) => { settled = true; return x; });
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(settled, false, 'the restore ran while a rebuild held the corpus lock');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  const r = await pending;
  assert.equal(r.ok, true);
  assert.equal(r.places, 1);
  assert.equal(r.restored, 168);
  const { rows } = await pool.query(
    `SELECT google_place_id, MIN(baseline) AS lo, MAX(baseline) AS hi, COUNT(*)::int AS n
       FROM ${LIVE} WHERE google_place_id LIKE 'ChIJsetAsideHarv%' GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(rows.map((x) => [x.google_place_id, x.lo, x.hi, x.n]),
    [['ChIJsetAsideHarv1', 30, 30, 168], ['ChIJsetAsideHarv2', 77, 77, 168]]);
  assert.equal((await rowsOf(SET_ASIDE)).length, 5 * 168, 'the set-aside table is left as it was');
  assert.equal((await restore(pool, { log: quiet })).restored, 0, 'a second restore puts back nothing');
});
