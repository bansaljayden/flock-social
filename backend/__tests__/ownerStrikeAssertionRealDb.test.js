// Run: node --test  (from backend/)
//
// THE OWNER SLIDER'S STRIKES, ON A REAL DATABASE (services/ownerReports.js).
//
// LIVE_OWNER_REPORTS_SQL decides which reading is served, where the venue's
// current assertion began and whether the venue is suppressed; applyOwnerReport
// decides whether a strike is stamped. A fake cannot prove the first half, so
// the readings are posted into a migrated schema and the serve path reads them
// back the way routes/crowd.js does.
//
// Two shapes used to cost an honest venue its slider for a month:
//
//   * THE RAMP. 40 while the room is quiet (three people in it say quiet,
//     which agrees with 40), then 55, 60, 65 as it fills. Each new number is
//     within 25 points of 40, so each one's assertion reached back to 40 and
//     the three quiet reports, filed while 40 was on screen and agreeing with
//     it, were judged against 55, 60 and 65 in turn: three strikes, suppressed.
//     A report carried forward from an earlier reading is now judged against
//     the reading that was on screen when it was filed.
//
//   * THE SPLIT ROOM. A 50 that three people call quiet and three call 50 is
//     35 against 50, no strike. The first fix for the ramp dropped the carried
//     reports that agreed, so re-posting the same 50 struck it on the quiet
//     half alone. No carried report is dropped.
//
//   * THE NUDGE. One contested 80 (the room says 50), then 84 and 78. One
//     disagreement about one claim was stamped three times, once per re-post.
//     An assertion is struck once.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('ownerStrikeAssertionRealDb');
const DB_NAME = 'flock_owner_strike_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';

const MIN = 60e3;

let pg;
let pool;
let dataDir;
let ownerReports;
let realQuery;
// markDiverged is fire-and-forget; every write it starts is collected here so
// a serve can wait for its own stamp before the next read.
let pending = [];
let seq = 0;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-owner-strike-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'ownerStrikeAssertionRealDb', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  realQuery = pool.query.bind(pool);
  pool.query = (text, params) => {
    const p = realQuery(text, params);
    if (/^\s*UPDATE venue_owner_reports SET diverged = true/.test(String(text))) pending.push(p.catch(() => {}));
    return p;
  };
  ownerReports = require('../services/ownerReports');
});

test.after(async () => {
  if (pool && realQuery) pool.query = realQuery;
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'ownerStrikeAssertionRealDb');
});

// A verified listing, with its own owner account, for each scenario: strikes
// and suppression are keyed on the place id.
const owners = new Map();
async function listing() {
  seq += 1;
  const placeId = `ChIJownerStrikeAssertion${String(seq).padStart(2, '0')}`;
  const owner = (await realQuery(
    `INSERT INTO users (email, password, name, role, email_verified)
     VALUES ($1, 'x', 'Owner', 'venue_owner', true) RETURNING id`,
    [`strike-owner-${seq}@example.com`]
  )).rows[0].id;
  await realQuery(
    `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified)
     VALUES ($1, $2, $3, true)`,
    [owner, `Room ${seq}`, placeId]
  );
  owners.set(placeId, owner);
  return placeId;
}

async function post(placeId, percent, agoMin) {
  const { rows } = await realQuery(
    `INSERT INTO venue_owner_reports (venue_user_id, google_place_id, busy_percent, created_at)
     VALUES ($1, $2, $3, NOW() - make_interval(mins => $4)) RETURNING id`,
    [owners.get(placeId), placeId, percent, agoMin]
  );
  return rows[0].id;
}

// Verified reports as the crowd routes hand them in. crowd_level 1 -> 20,
// 2 -> 50, 3 -> 80.
function reports(userIds, level, agoMin) {
  return userIds.map((uid) => ({ user_id: uid, crowd_level: level, created_at: new Date(Date.now() - agoMin * MIN) }));
}

// One serve of the card, the way routes/crowd.js applies the override, then
// the stamp it started, if any, allowed to land.
async function serve(placeId, feedbackRows) {
  const row = (await ownerReports.getLiveOwnerReports([placeId]))[placeId];
  const payload = { score: 30, label: 'Some people', rawEngineScore: 30, calibration: { feedbackUsed: false, reportCount: 0 } };
  const out = ownerReports.applyOwnerReport(payload, row, { feedbackRows });
  await Promise.all(pending);
  pending = [];
  return out;
}

async function struck(placeId) {
  const { rows } = await realQuery(
    'SELECT busy_percent FROM venue_owner_reports WHERE google_place_id = $1 AND diverged = true ORDER BY created_at',
    [placeId]
  );
  return rows.map((r) => r.busy_percent);
}

test('an owner raising the number as the room fills is not struck by reports that agreed with the earlier number', async () => {
  const place = await listing();
  const room = reports([11, 12, 13], 1, 66); // quiet, filed while 40 was up

  await post(place, 40, 70);
  assert.strictEqual((await serve(place, room)).score, 40);
  await post(place, 55, 40);
  await serve(place, room);
  await post(place, 60, 20);
  await serve(place, room);
  await post(place, 65, 1);
  const last = await serve(place, room);

  assert.deepStrictEqual(await struck(place), [],
    'three quiet reports that agreed with 40 were charged against 55, 60 and 65');
  assert.strictEqual(last.score, 65, 'and the slider is still the number, not suppressed for a month');
});

test('re-posting an unchanged reading does not turn a split room into a strike', async () => {
  // Three people say quiet and three say what the venue says: 35 against 50,
  // inside the 25 points. Posting the same 50 again adds no disagreement, and
  // dropping the three who agreed would leave the quiet half as the whole room.
  const place = await listing();
  const room = [...reports([51, 52, 53], 1, 30), ...reports([54, 55, 56], 2, 30)];

  await post(place, 50, 40);
  await serve(place, room);
  assert.deepStrictEqual(await struck(place), []);
  await post(place, 50, 1);
  const last = await serve(place, room);

  assert.deepStrictEqual(await struck(place), [], 'the re-post was struck on half the room');
  assert.strictEqual(last.score, 50);
});

test('an owner who moves toward the room is not struck for the number they moved off', async () => {
  // 40 while the room says 80, then 60: inside 25 points of 40, so the same
  // assertion, and inside 25 points of the room. The reports disagreed with 40
  // by 40 points; against 60 they disagree by 20, and 60 is what is judged.
  const place = await listing();
  await post(place, 40, 50);
  await post(place, 60, 10);
  const last = await serve(place, reports([57, 58, 59], 3, 40));
  assert.deepStrictEqual(await struck(place), []);
  assert.strictEqual(last.score, 60);
});

test('one contested reading nudged twice is one strike, not three', async () => {
  const place = await listing();
  const room = reports([21, 22, 23], 2, 42); // the room says 50

  await post(place, 80, 50);
  await serve(place, room);
  assert.deepStrictEqual(await struck(place), [80], 'the reading the room contradicted is struck');

  await post(place, 84, 30);
  await serve(place, room);
  await post(place, 78, 10);
  const last = await serve(place, room);

  assert.deepStrictEqual(await struck(place), [80], 'the same claim, re-posted, was struck again');
  assert.strictEqual(last.score, 78, 'one disagreement is not a pattern, so nothing is suppressed');
});

test('re-posting a number the room contradicted still carries the evidence forward', async () => {
  // Abuse case N against real SQL: the reports were filed while the first 95
  // was up and disagreed with it, so they are evidence against the re-post.
  const place = await listing();
  await post(place, 95, 40);
  await post(place, 95, 0);
  await serve(place, reports([31, 32, 33], 1, 30));
  assert.deepStrictEqual(await struck(place), [95]);
});

test('a strike on an earlier claim does not shield a different claim', async () => {
  const place = await listing();
  await post(place, 90, 60);
  await serve(place, reports([41, 42, 43], 1, 55));
  assert.deepStrictEqual(await struck(place), [90]);
  // 20 is more than 25 points from 90, so it is a new assertion: still judged.
  await post(place, 20, 10);
  await serve(place, reports([44, 45, 46], 3, 5));
  assert.deepStrictEqual(await struck(place), [90, 20]);
});
