// ---------------------------------------------------------------------------
// THE LABEL QUARANTINE IN SQL (services/labelQuarantine.json, 2026-11-27).
//
// Two readers of ml_training_data filter the quarantined window inside their
// own query: the older CSV export (scripts/ml/exportCsv.js) and the admin
// Model card (services/moneyHub.js). Here both run against the real schema
// (the migration chain), on rows that sit on every side of the window, so the
// NULLs of weekly and spring rows are Postgres's to judge, not a regex's.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-label-quarantine-sql';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('labelQuarantineSql');
let pg;
let pool;
let dataDir;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-quarantine-sql-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'labelQuarantineSql', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_quarantine_sql_test');
  pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_quarantine_sql_test` });
  const { migrate } = require('../db/migrate');
  await migrate(pool);
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'labelQuarantineSql');
});

// One venue, and one realtime row per case (distinct hours, so the realtime
// unique key on venue, weekday, hour and date never collides).
const CASES = [
  { tag: 'weekly', mode: 'weekly', source: null, date: null, hour: 1, kept: true },
  { tag: 'spring, no source', mode: 'realtime', source: null, date: '2026-04-03', hour: 2, kept: true },
  { tag: 'real live', mode: 'realtime', source: 'live', date: '2026-10-09', hour: 3, kept: true },
  { tag: 'first generated day', mode: 'realtime', source: 'live', date: '2026-10-23', hour: 4, kept: false },
  { tag: 'generated', mode: 'realtime', source: 'live', date: '2026-11-06', hour: 5, kept: false },
  { tag: 'last generated day', mode: 'realtime', source: 'live', date: '2026-11-25', hour: 6, kept: false },
  { tag: 'vendor forecast in the window', mode: 'realtime', source: 'forecast', date: '2026-11-06', hour: 7, kept: true },
  { tag: 'live, no date', mode: 'realtime', source: 'live', date: null, hour: 8, kept: true },
  { tag: 'live after the window', mode: 'realtime', source: 'live', date: '2026-11-26', hour: 9, kept: true },
];

async function seed() {
  const { rows: [v] } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
     VALUES ('ChIJ-quarantine-sql', 'Quarantine Bar', 'philly', 39.95, -75.16, 'bar', 'America/New_York') RETURNING id`);
  const ids = {};
  for (const c of CASES) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO ml_training_data (venue_id, collection_mode, day_of_week, hour, venue_category, busyness_pct, label_source,
                                     observed_date, vendor_forecast_pct, collected_at, hour_axis)
       VALUES ($1, $2, 5, $3, 'bar', 40, $4, $5::date, $6, NOW(), $7) RETURNING id`,
      [v.id, c.mode, c.hour, c.source, c.date, c.source === 'forecast' ? 40 : null, c.mode === 'weekly' ? 'venue_local' : null]);
    ids[c.tag] = r.id;
  }
  return ids;
}

test('the older CSV export leaves out exactly the live rows dated inside the window, and counts them', async () => {
  const ids = await seed();
  const { buildExportQuery } = require('../scripts/ml/exportCsv');
  const q = buildExportQuery('all');
  const { rows } = await pool.query(q.text, q.params);
  const got = new Set(rows.map((r) => r.id));
  for (const c of CASES) assert.equal(got.has(ids[c.tag]), c.kept, `${c.tag}: kept should be ${c.kept}`);
  const { rows: [n] } = await pool.query(q.countText, q.countParams);
  assert.equal(n.n, CASES.filter((c) => !c.kept).length);
  const rt = buildExportQuery('realtime');
  const { rows: rtRows } = await pool.query(rt.text, rt.params);
  assert.deepEqual(new Set(rtRows.map((r) => r.id)),
    new Set(CASES.filter((c) => c.kept && c.mode === 'realtime').map((c) => ids[c.tag])));
});

// The admin Model card. One served forecast and one live reading on each of
// the two days either side of each edge of the window, every pair inside the
// card's pairing rules, and each forecast carrying its own date as its model
// version, so the versions the card reports name exactly the days it graded.
const CARD_DAYS = [
  { date: '2026-10-21', kept: true },
  { date: '2026-10-22', kept: true },
  { date: '2026-10-23', kept: false },
  { date: '2026-10-24', kept: false },
  { date: '2026-11-24', kept: false },
  { date: '2026-11-25', kept: false },
  { date: '2026-11-26', kept: true },
  { date: '2026-11-27', kept: true },
];

test('the admin Model card grades only the served forecasts whose reading falls outside the window', async () => {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password, name) VALUES ('quarantine-card@example.test', 'x', 'Card') RETURNING id`);
  const place = 'ChIJ-quarantine-card';
  const { rows: [v] } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
     VALUES ($1, 'Quarantine Card Bar', 'philly', 39.95, -75.16, 'bar', 'America/New_York') RETURNING id`, [place]);
  for (const d of CARD_DAYS) {
    const servedAt = `${d.date}T15:00:00Z`;
    const dow = new Date(servedAt).getUTCDay();
    await pool.query(
      `INSERT INTO served_predictions (user_id, venue_place_id, score, prediction_method, model_version, served_at, local_day, local_hour)
       VALUES ($1, $2, 40, 'ml', $3, $4::timestamptz, $5, 15)`,
      [u.id, place, `v-${d.date}`, servedAt, dow]);
    await pool.query(
      `INSERT INTO ml_training_data (venue_id, collection_mode, day_of_week, hour, venue_category, busyness_pct, label_source,
                                     observed_date, collected_at)
       VALUES ($1, 'realtime', $2, 15, 'bar', 40, 'live', $3::date, $4::timestamptz)`,
      [v.id, dow, d.date, servedAt]);
  }
  const moneyHub = require('../services/moneyHub');
  const { cuts } = moneyHub.crowdBandLadder();
  // A window that reaches back past the first day, however long after it this runs.
  const windowDays = Math.ceil((Date.now() - Date.parse('2026-10-20T00:00:00Z')) / 86400000) + 1;
  const versions = (row) => [...row.versions].sort();
  const kept = CARD_DAYS.filter((d) => d.kept).map((d) => `v-${d.date}`);

  // Without the quarantine, every one of the eight pairs is graded, so the
  // pairing itself is not what leaves anything out below.
  const { rows: [open] } = await pool.query(moneyHub.SERVED_BAND_ACCURACY_SQL,
    [windowDays, cuts, 3, [], []]);
  assert.equal(open.matched, CARD_DAYS.length);
  assert.deepEqual(versions(open), CARD_DAYS.map((d) => `v-${d.date}`));

  // With it, exactly the four days outside the window, from the card's own reader.
  const card = await moneyHub.readServedBandAccuracy(pool, { windowDays, cuts });
  assert.equal(card.status, 'ok');
  assert.equal(card.served, CARD_DAYS.length);
  assert.equal(card.matched, kept.length);
  assert.equal(card.days, kept.length);
  const { rows: [shut] } = await pool.query(moneyHub.SERVED_BAND_ACCURACY_SQL,
    [windowDays, cuts, 3, ['2026-10-23'], ['2026-11-25']]);
  assert.deepEqual(versions(shut), kept);
});
