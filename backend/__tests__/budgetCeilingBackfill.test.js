'use strict';
// Run: node --test  (from backend/)
//
// Migration 027 — the flocks.budget_ceiling band backfill, against a REAL
// Postgres.
//
// SECURITY-AUDIT-injection-idor.md I-1 (round 2). Commit 1fdea72 made the
// published ceiling a BAND instead of the raw MIN, but banded only on the way
// INTO flocks.budget_ceiling. Rows cached before that deploy still hold one
// member's exact budget, and no migration ever moved them. 027 is that
// migration, and this file is its proof.
//
// Why a real database and not a scripted pg fake: the whole content of 027 is
// numeric arithmetic (FLOOR on DECIMAL(8,2), and Postgres's scale-insensitive
// numeric equality inside `IS DISTINCT FROM`). A fake would be asserting what
// this file was written to find out.
//
// What is pinned, and why each row exists:
//   * one row per band and per band EDGE — 50 and 5 and 1 are the thresholds,
//     and a value sitting exactly on one must stay put rather than drop a band.
//   * the audit's own number, $47.13, which must land on $45.
//   * sub-dollar values, whose band is a flat cent (never 0 — the app reads
//     this field for truthiness and would render a 0 as "no ceiling yet").
//   * NULL — nothing to leak, must not be written.
//   * 0 and a negative, which bandCeiling() answers null for; the migration
//     must agree rather than invent a band for them.
//   * a large value at the column's ceiling (DECIMAL(8,2) tops out at
//     999999.99), so the arithmetic is exercised where overflow would bite.
//   * every already-banded value, which must be left UNTOUCHED — proven by
//     xmin, not by value, because "rewrote it to the same number" is not
//     idempotent, it is churn.
//   * the whole file run twice: the second run must write nothing at all.
//
// Every expectation is DERIVED from routes/budget.js's bandCeiling(), not
// copied as a literal, because the thing that must not drift is the agreement
// between the SQL and that function. A handful of hard literals sit alongside
// the derivation so a broken derivation cannot silently agree with broken SQL.
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

const { bandCeiling } = require('../routes/budget');

const MIGRATION_FILE = '027_backfill_banded_budget_ceilings.sql';
const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', MIGRATION_FILE);

// This suite boots its own embedded Postgres, so its port must be distinct from
// e2e-local.js's 59595 and from every sibling suite that does the same. It used
// to be the hardcoded 59787, which held right up until a run was killed: the
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
const PG_PORT = pickEmbeddedPgPort('budgetCeilingBackfill');

// tag -> the value the pre-fix code cached. `null` means the column was never
// written. Strings, because that is how a DECIMAL arrives and leaves pg.
const SEEDS = {
  noCeiling:      null,
  zero:           '0.00',
  negative:       '-1.00',
  oneCent:        '0.01',
  subDollar:      '0.40',
  justUnderADollar: '0.99',
  exactlyADollar: '1.00',
  lowBand:        '3.50',
  justUnderFive:  '4.99',
  exactlyFive:    '5.00',
  midBand:        '12.75',
  victim:         '47.13',   // the audit's number
  justUnderFifty: '49.99',
  exactlyFifty:   '50.00',
  bigBand:        '99.99',
  large:          '9999.99',
  columnMax:      '999999.99',
};

let pg;
let pool;
let dataDir;
const ids = {};       // tag -> flocks.id
// tag -> the xmin the seeding INSERT stamped. Captured per row and not assumed
// equal across rows: each seed is its own autocommitted statement, so they do
// NOT share a transaction id.
const seedXmin = {};

async function fetchRows() {
  const { rows } = await pool.query(
    // xmin identifies the last writing transaction: an untouched row keeps its
    // xmin, a rewritten-to-the-same-value row would not.
    `SELECT id, budget_ceiling, updated_at, xmin::text AS xm FROM flocks ORDER BY id`
  );
  return rows;
}
const byTag = (rows) => Object.fromEntries(
  Object.entries(ids).map(([tag, id]) => [tag, rows.find((r) => r.id === id)])
);

const runMigrationSql = () => pool.query(fs.readFileSync(MIGRATION_PATH, 'utf8'));

// What the column should read after the backfill, as a number (or null).
const asNumber = (v) => (v === null ? null : Number(v));

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-ceilingband-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'budgetCeilingBackfill', port: PG_PORT, databaseDir: dataDir,
  });
  // Not pg.start(): the wrapper turns embedded-postgres's bare reject() into an
  // error that names the suite, the port, and whether an orphan is holding it.
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_ceilingband_test');

  pool = new Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_ceilingband_test`,
  });

  // The REAL chain, via the REAL runner: 027 must apply cleanly in order, or
  // production's boot (server.js awaits migrate() before listen) dies with it.
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const creator = await pool.query(
    `INSERT INTO users (email, password, name) VALUES ('ceilingband@example.com', 'x', 'Band Tester') RETURNING id`
  );
  const creatorId = creator.rows[0].id;

  for (const [tag, seeded] of Object.entries(SEEDS)) {
    const { rows } = await pool.query(
      `INSERT INTO flocks (name, creator_id, budget_ceiling) VALUES ($1, $2, $3) RETURNING id, xmin::text AS xm`,
      [`flock for ${tag}`, creatorId, seeded]
    );
    ids[tag] = rows[0].id;
    seedXmin[tag] = rows[0].xm;
  }
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  // Tolerated, unlike the sibling migration suites: under the FULL suite this
  // file runs alongside the other embedded-Postgres tests, and Windows was
  // observed still holding a handle on the data directory after pg.stop()
  // returned — an EPERM here failed a file whose nine assertions had all
  // passed. A leftover temp directory is an untidy machine, not a broken
  // migration, and `persistent: false` means the next run makes its own.
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn('[budgetCeilingBackfill] could not remove %s: %s', dataDir, err.message);
  }
});

test('027 exists at its number, and carries no directive line (default = one transaction)', () => {
  const src = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.ok(
    !/^--\s*@(tolerant|noTransaction)/.test(src.trimStart()),
    '027 must run in default transactional mode so a failure rolls the whole backfill back'
  );
  const dir = path.join(__dirname, '..', 'migrations');
  const at027 = fs.readdirSync(dir).filter((f) => f.startsWith('027'));
  assert.deepStrictEqual(at027, [MIGRATION_FILE], 'two files at number 027 would race in name order');
});

test('the migration runner applied 027 as part of the real chain', async () => {
  const { rows } = await pool.query(
    'SELECT 1 FROM schema_migrations WHERE name = $1', [MIGRATION_FILE]
  );
  assert.strictEqual(rows.length, 1, '027 was not recorded in schema_migrations by db/migrate.js');
});

test('the backfill lands every stored ceiling on exactly the band bandCeiling() computes', async () => {
  // Sanity on the fixture first: at least the headline rows must actually be
  // WRONG before the migration, or the test proves nothing.
  for (const tag of ['victim', 'subDollar', 'lowBand', 'bigBand']) {
    assert.notStrictEqual(
      Number(SEEDS[tag]), bandCeiling(SEEDS[tag]),
      `fixture ${tag}: the seed already equals its band, so it cannot detect the backfill`
    );
  }

  await runMigrationSql();

  const rows = byTag(await fetchRows());
  for (const [tag, seeded] of Object.entries(SEEDS)) {
    assert.strictEqual(
      asNumber(rows[tag].budget_ceiling), bandCeiling(seeded),
      `${tag}: seeded ${seeded}, migration disagrees with routes/budget.js bandCeiling()`
    );
  }

  // Hard literals for the headline conversions, so a broken derivation cannot
  // silently agree with broken SQL. $47.13 is the audit's victim amount.
  assert.strictEqual(asNumber(rows.victim.budget_ceiling), 45);
  assert.strictEqual(asNumber(rows.subDollar.budget_ceiling), 0.01);
  assert.strictEqual(asNumber(rows.lowBand.budget_ceiling), 3);
  assert.strictEqual(asNumber(rows.bigBand.budget_ceiling), 90);
  assert.strictEqual(asNumber(rows.large.budget_ceiling), 9990);
  assert.strictEqual(asNumber(rows.columnMax.budget_ceiling), 999990);
});

test('the backfill never rounds UP, and never publishes a 0 ceiling', async () => {
  const rows = byTag(await fetchRows());
  for (const [tag, seeded] of Object.entries(SEEDS)) {
    const after = asNumber(rows[tag].budget_ceiling);
    if (after === null) continue;
    assert.ok(
      after <= Number(seeded),
      `${tag}: ${seeded} was rounded UP to ${after} — a cap above the lowest submitted budget`
    );
    assert.ok(after > 0, `${tag}: published a 0 ceiling, which the app reads as "no ceiling yet"`);
  }
});

test('band edges stay on their edge, and a NULL/0/negative ceiling is not invented into one', async () => {
  const rows = byTag(await fetchRows());
  // $50 publishes $50 ("somewhere in [50, 60)"), not $40. Same for 5 and 1.
  assert.strictEqual(asNumber(rows.exactlyFifty.budget_ceiling), 50);
  assert.strictEqual(asNumber(rows.exactlyFive.budget_ceiling), 5);
  assert.strictEqual(asNumber(rows.exactlyADollar.budget_ceiling), 1);
  assert.strictEqual(asNumber(rows.oneCent.budget_ceiling), 0.01);

  // Nothing to withhold, and nothing to invent. bandCeiling() answers null for
  // anything not strictly positive; the SQL must answer the same.
  assert.strictEqual(rows.noCeiling.budget_ceiling, null);
  assert.strictEqual(rows.zero.budget_ceiling, null);
  assert.strictEqual(rows.negative.budget_ceiling, null);
  assert.strictEqual(bandCeiling('0.00'), null);
  assert.strictEqual(bandCeiling('-1.00'), null);
});

test('rows already on their band were not touched at all — not even rewritten (xmin proof)', async () => {
  const rows = byTag(await fetchRows());
  // Every seed that was already its own band, plus the NULL row. If the
  // predicate ever loses its `IS DISTINCT FROM` half, these rewrite themselves
  // to the same number and this goes red.
  const untouched = Object.entries(SEEDS)
    .filter(([, seeded]) => seeded === null || Number(seeded) === bandCeiling(seeded))
    .map(([tag]) => tag);
  assert.ok(untouched.length >= 5, 'the fixture lost its already-banded rows');
  for (const tag of untouched) {
    assert.strictEqual(
      rows[tag].xm, seedXmin[tag],
      `${tag}: an already-banded row was rewritten by the backfill`
    );
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

test('the backfill did not bump updated_at, which is the flock list ORDER BY', async () => {
  // routes/flocks.js GET / orders on f.updated_at DESC. A privacy repair that
  // reshuffled every user's home screen would be a visible side effect of an
  // invisible fix.
  const rows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM flocks WHERE updated_at > created_at + INTERVAL '1 second'`
  );
  assert.strictEqual(rows.rows[0].n, 0, 'the backfill moved updated_at');
});

test('the migration itself agrees with bandCeiling() across a sweep, not just at the fixture values', async () => {
  // The fixture names the interesting values; this sweeps the space between
  // them through the REAL migration file (not a retyped copy of its CASE, which
  // is the version of this test that would pass while the migration is wrong),
  // so a threshold typo that misses every hand-picked row still fails here.
  const probes = [];
  for (let cents = 1; cents <= 200000; cents += 379) probes.push((cents / 100).toFixed(2));

  const creator = await pool.query('SELECT id FROM users LIMIT 1');
  const { rows: inserted } = await pool.query(
    `INSERT INTO flocks (name, creator_id, budget_ceiling)
     SELECT 'sweep', $1, v::numeric FROM unnest($2::text[]) AS v
     RETURNING id, budget_ceiling`,
    [creator.rows[0].id, probes]
  );
  assert.strictEqual(inserted.length, probes.length);
  const seededById = new Map(inserted.map((r) => [r.id, r.budget_ceiling]));

  await runMigrationSql();

  const { rows: after } = await pool.query(
    `SELECT id, budget_ceiling FROM flocks WHERE id = ANY($1::int[])`,
    [[...seededById.keys()]]
  );
  assert.strictEqual(after.length, probes.length);
  for (const r of after) {
    const seeded = seededById.get(r.id);
    assert.strictEqual(
      asNumber(r.budget_ceiling), bandCeiling(seeded),
      `migration 027 and bandCeiling() disagree at ${seeded}`
    );
    assert.ok(Number(r.budget_ceiling) <= Number(seeded), `${seeded} was rounded UP`);
  }
});
