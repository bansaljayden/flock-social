'use strict';
// ---------------------------------------------------------------------------
// Migration 021 — the venue_feedback bucket backfill, against a REAL Postgres.
//
// A scripted pg fake cannot tell you what `created_at AT TIME ZONE tz` returns
// (the reason adminEvidence.test.js's SQL semantics were verified out-of-repo),
// and this migration IS that expression — so this file boots the repo's
// embedded-postgres dev dependency (same engine scripts/e2e-local.js uses),
// applies the real migration chain with db/migrate.js, seeds rows shaped like
// the four provenances production actually holds, and runs 021's SQL against
// them the way a deploy would.
//
// What is pinned, and why each row exists:
//   * a pre-fix EST row and a pre-fix EDT row — America/New_York sits on BOTH
//     sides of a DST transition over the corpus's lifetime, so one winter and
//     one summer instant prove the offset is looked up per-row, not assumed.
//   * both halves of the repeated 1:30am on 2026-11-01 (fall back), and an
//     instant just past the nonexistent 2am on 2026-03-08 (spring forward) —
//     the boundary rows a naive fixed-offset backfill gets wrong.
//   * a post-fix-shaped row (bucket already equals the venue-local
//     recomputation) — must not be touched, proven by xmin, not just values.
//   * a row whose venue is not in ml_venues, and a row whose ml_venues
//     timezone is garbage — both must survive UNTOUCHED, and the garbage zone
//     must not abort the transaction (unguarded it would fail the boot).
//   * a venue whose zone IS UTC — its "UTC bucket" is already correct and must
//     not be rewritten.
//   * the whole file run twice — the second run must write NOTHING (xmin
//     snapshot identical), pinning "idempotent by construction".
//   * the day-numbering convention: EXTRACT(DOW) 0=Sunday must equal JS
//     Date#getDay() 0=Sunday, since routes/feedback.js writes the JS
//     convention and 021 recomputes with the SQL one.
//
// Expected buckets are derived here with Intl/getDay (the same machinery
// feedback.js uses) rather than copied as literals — if the two conventions
// ever diverged, the derivation and the SQL would disagree and this file goes
// red naming it.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

const MIGRATION_FILE = '021_backfill_feedback_local_buckets.sql';
const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', MIGRATION_FILE);

// This suite boots its own embedded Postgres, so its port must be distinct from
// e2e-local.js's 59595 and from every sibling suite that does the same. It used
// to be the hardcoded 59641, which held right up until a run was killed: the
// orphaned postgres kept the port and broke every LATER run of this file
// permanently, reported only as `hookFailed: undefined`.
//
// pickEmbeddedPgPort keeps the distinctness, by giving each suite a disjoint
// range of its own, and adds orphan-immunity on top of it. The candidate port
// starts from a process.pid-derived offset, so a fresh run never starts where an
// orphan of some dead process sits, and it is then confirmed free by an actual
// bind. See __tests__/helpers/embeddedPgPort.js.
// It resolves SYNCHRONOUSLY, so it is usable at module scope like the constant
// it replaces.
const PG_PORT = pickEmbeddedPgPort('feedbackBackfillMigration');

const KNOWN_PLACE = 'ChIJbackfillKnownNY01';   // in ml_venues, America/New_York
const UTC_PLACE = 'ChIJbackfillUtcVenue1';     // in ml_venues, UTC
const GARBAGE_PLACE = 'ChIJbackfillGarbage1';  // in ml_venues, unusable zone
const UNKNOWN_PLACE = 'ChIJbackfillUnknown01'; // NOT in ml_venues

// The venue-local bucket for an instant, derived the way routes/feedback.js
// derives it (Intl weekday + hour in the venue zone), NOT hand-computed — this
// is the convention pin.
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function jsLocalBucket(timeZone, isoInstant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, weekday: 'short', hour: 'numeric',
  }).formatToParts(new Date(isoInstant));
  const day = WEEKDAY_INDEX[parts.find((p) => p.type === 'weekday').value];
  let hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  if (hour === 24) hour = 0; // some ICU builds render midnight as "24"
  return { day, hour };
}
// The UTC bucket the PRE-FIX code (EXTRACT from a UTC NOW()) would have stored.
function utcBucket(isoInstant) {
  const d = new Date(isoInstant);
  return { day: d.getUTCDay(), hour: d.getUTCHours() };
}

// tag -> { place, at, seeded } ; seeded = what the writing code stored.
const ROWS = {
  // Pre-fix rows: seeded with the UTC bucket, venue in America/New_York.
  estPreFix:      { place: KNOWN_PLACE, at: '2026-01-10T02:30:00Z', seeded: utcBucket('2026-01-10T02:30:00Z') },
  edtPreFix:      { place: KNOWN_PLACE, at: '2026-07-04T01:00:00Z', seeded: utcBucket('2026-07-04T01:00:00Z') },
  // 2026-11-01: clocks fall back at 2:00 EDT (06:00Z). 05:30Z and 06:30Z are
  // the first and second 1:30am — same wall bucket, different offsets.
  fallBackFirst:  { place: KNOWN_PLACE, at: '2026-11-01T05:30:00Z', seeded: utcBucket('2026-11-01T05:30:00Z') },
  fallBackSecond: { place: KNOWN_PLACE, at: '2026-11-01T06:30:00Z', seeded: utcBucket('2026-11-01T06:30:00Z') },
  // 2026-03-08: 2:00-2:59 EST does not exist; 07:30Z is 3:30 EDT.
  springForward:  { place: KNOWN_PLACE, at: '2026-03-08T07:30:00Z', seeded: utcBucket('2026-03-08T07:30:00Z') },
  // Post-fix row: seeded with the venue-local bucket already (fixed point).
  postFix:        { place: KNOWN_PLACE, at: '2026-08-14T01:30:00Z', seeded: jsLocalBucket('America/New_York', '2026-08-14T01:30:00Z') },
  // A venue whose zone IS UTC: the "UTC bucket" is the right answer.
  utcVenue:       { place: UTC_PLACE, at: '2026-01-10T02:30:00Z', seeded: utcBucket('2026-01-10T02:30:00Z') },
  // No ml_venues row at all: no honest recomputation exists, must not move.
  noTimezone:     { place: UNKNOWN_PLACE, at: '2026-01-10T02:30:00Z', seeded: utcBucket('2026-01-10T02:30:00Z') },
  // ml_venues row exists but its timezone is garbage: must not move, and must
  // not raise (an unguarded AT TIME ZONE here aborts the whole migration).
  garbageTz:      { place: GARBAGE_PLACE, at: '2026-01-10T02:30:00Z', seeded: utcBucket('2026-01-10T02:30:00Z') },
};

let pg;
let pool;
let dataDir;
const ids = {}; // tag -> venue_feedback.id

async function fetchRows() {
  const { rows } = await pool.query(
    // xmin identifies the last writing transaction: an untouched row keeps
    // its xmin, a rewritten-to-the-same-values row would not.
    `SELECT id, venue_place_id, day_of_week, hour, xmin::text AS xm
     FROM venue_feedback ORDER BY id`
  );
  return rows;
}
const byTag = (rows) => Object.fromEntries(
  Object.entries(ids).map(([tag, id]) => [tag, rows.find((r) => r.id === id)])
);

const runMigrationSql = () => pool.query(fs.readFileSync(MIGRATION_PATH, 'utf8'));

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-backfill-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'feedbackBackfillMigration', port: PG_PORT, databaseDir: dataDir,
  });
  // Not pg.start(): the wrapper turns embedded-postgres's bare reject() into an
  // error that names the suite, the port, and whether an orphan is holding it.
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_backfill_test');

  pool = new Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_backfill_test`,
  });

  // The REAL chain, via the REAL runner: 021 must apply cleanly in order, or
  // production's boot (server.js awaits migrate() before listen) dies with it.
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  // Seed reference venues + feedback rows shaped like production provenances.
  for (const [placeId, tz, name] of [
    [KNOWN_PLACE, 'America/New_York', 'Backfill Known Venue'],
    [UTC_PLACE, 'UTC', 'Backfill UTC Venue'],
    [GARBAGE_PLACE, 'Gotham/Nowhere', 'Backfill Garbage Venue'],
  ]) {
    await pool.query(
      `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
       VALUES ($1, $2, 'Philadelphia', 39.95, -75.16, 'bar', $3)`,
      [placeId, name, tz]
    );
  }
  for (const [tag, row] of Object.entries(ROWS)) {
    const { rows } = await pool.query(
      `INSERT INTO venue_feedback
         (user_id, venue_place_id, venue_name, crowd_level, day_of_week, hour, verified, created_at)
       VALUES (NULL, $1, $2, 2, $3, $4, true, $5::timestamptz)
       RETURNING id`,
      [row.place, `Venue for ${tag}`, row.seeded.day, row.seeded.hour, row.at]
    );
    ids[tag] = rows[0].id;
  }
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('021 exists at its number, and carries no directive line (default = one transaction)', () => {
  const src = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.ok(
    !/^--\s*@(tolerant|noTransaction)/.test(src.trimStart()),
    '021 must run in default transactional mode so a failure rolls the whole backfill back'
  );
  // And nothing else claims the number.
  const dir = path.join(__dirname, '..', 'migrations');
  const at021 = fs.readdirSync(dir).filter((f) => f.startsWith('021'));
  assert.deepStrictEqual(at021, [MIGRATION_FILE], 'two files at number 021 would race in name order');
});

test('the migration runner applied 021 as part of the real chain', async () => {
  const { rows } = await pool.query(
    'SELECT 1 FROM schema_migrations WHERE name = $1', [MIGRATION_FILE]
  );
  assert.strictEqual(rows.length, 1, '021 was not recorded in schema_migrations by db/migrate.js');
});

test('day-numbering convention: EXTRACT(DOW) and JS getDay() agree that Sunday is 0', async () => {
  // 2026-01-04 is a Sunday. feedback.js writes the JS convention; 021
  // recomputes with the SQL one. If they ever diverged, every backfilled row
  // would land one notch off — this is the pin.
  const js = new Date('2026-01-04T12:00:00Z').getUTCDay();
  const { rows } = await pool.query(
    `SELECT EXTRACT(DOW FROM (TIMESTAMPTZ '2026-01-04T12:00:00Z' AT TIME ZONE 'UTC'))::int AS dow`
  );
  assert.strictEqual(js, 0);
  assert.strictEqual(rows[0].dow, 0, 'Postgres EXTRACT(DOW) no longer numbers Sunday as 0');
});

test('the backfill corrects UTC-bucketed rows to the venue wall clock, on both sides of DST', async () => {
  // Sanity on the fixture itself first: every pre-fix seed must actually be
  // WRONG under the venue clock, or the test proves nothing.
  for (const tag of ['estPreFix', 'edtPreFix', 'fallBackFirst', 'fallBackSecond', 'springForward']) {
    const want = jsLocalBucket('America/New_York', ROWS[tag].at);
    assert.notDeepStrictEqual(
      { day: ROWS[tag].seeded.day, hour: ROWS[tag].seeded.hour }, want,
      `fixture ${tag}: the seeded UTC bucket already equals the local bucket, so it cannot detect the backfill`
    );
  }

  await runMigrationSql(); // must not throw — the garbage zone is in the table

  const rows = byTag(await fetchRows());
  const expect = (tag, tz) => {
    const want = jsLocalBucket(tz, ROWS[tag].at);
    assert.strictEqual(rows[tag].day_of_week, want.day, `${tag}: day_of_week`);
    assert.strictEqual(rows[tag].hour, want.hour, `${tag}: hour`);
  };
  expect('estPreFix', 'America/New_York');      // Jan 10 02:30Z -> Fri(5) 21h EST
  expect('edtPreFix', 'America/New_York');      // Jul 4 01:00Z  -> Fri(5) 21h EDT
  expect('springForward', 'America/New_York');  // Mar 8 07:30Z  -> Sun(0) 3h (2am skipped)
  // Fall back: the repeated wall hour. Both instants are the venue's Sunday
  // 1am — one bucket, by design of bucket keys.
  expect('fallBackFirst', 'America/New_York');
  expect('fallBackSecond', 'America/New_York');
  assert.strictEqual(rows.fallBackFirst.day_of_week, 0);
  assert.strictEqual(rows.fallBackFirst.hour, 1);
  assert.strictEqual(rows.fallBackSecond.hour, 1,
    'the second 1:30am must land on wall hour 1 too — AT TIME ZONE resolves the ambiguity by the actual instant');

  // Hard literals for the two headline corrections, so a broken derivation
  // cannot silently agree with broken SQL: 2026-01-09 21:30 EST and
  // 2026-07-03 21:00 EDT are both Friday(5) 21h.
  assert.deepStrictEqual(
    [rows.estPreFix.day_of_week, rows.estPreFix.hour, rows.edtPreFix.day_of_week, rows.edtPreFix.hour],
    [5, 21, 5, 21]
  );
});

test('rows with no honest recomputation are untouched — not even rewritten to the same values', async () => {
  const rows = byTag(await fetchRows());
  for (const tag of ['noTimezone', 'garbageTz', 'utcVenue', 'postFix']) {
    assert.strictEqual(rows[tag].day_of_week, ROWS[tag].seeded.day, `${tag}: day_of_week moved`);
    assert.strictEqual(rows[tag].hour, ROWS[tag].seeded.hour, `${tag}: hour moved`);
  }
});

test('running the migration twice writes nothing the second time (fixed point, pinned by xmin)', async () => {
  const before = await fetchRows();
  await runMigrationSql();
  const after = await fetchRows();
  // xmin included: identical xmin per row means the second run performed ZERO
  // writes — not "wrote the same values again", which would churn dead tuples
  // and defeat "idempotent by construction".
  assert.deepStrictEqual(after, before, 'the second run changed or rewrote rows');
});

test('the untouched categories kept their original inserting transaction (xmin proof)', async () => {
  // The corrected rows were updated once; these four never were. If the
  // UPDATE's WHERE ever widens (e.g. drops the disagreement predicate), the
  // post-fix row's xmin changes and this goes red even though its values
  // cannot.
  const rows = byTag(await fetchRows());
  const touched = new Set([rows.estPreFix.xm, rows.edtPreFix.xm, rows.fallBackFirst.xm, rows.fallBackSecond.xm, rows.springForward.xm]);
  for (const tag of ['noTimezone', 'garbageTz', 'utcVenue', 'postFix']) {
    assert.ok(!touched.has(rows[tag].xm),
      `${tag} shares a writing transaction with the corrected rows — it was updated by the backfill`);
  }
});
