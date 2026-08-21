'use strict';
// ---------------------------------------------------------------------------
// THE MIGRATION CHAIN, RUN THE WAY A DEPLOY RUNS IT, THEN RUN AGAIN.
// ---------------------------------------------------------------------------
//
// server.js awaits db/migrate.js before server.listen(). A migration that
// throws is not a failed migration, it is a failed BOOT: the runner logs
// `FATAL: migration failed`, the process exits 1, Railway restarts it, the new
// container hits the same statement, and production stays down until a human
// reads the log. That makes "does every file in backend/migrations survive
// contact with a database that already has the schema AND the data" the single
// highest-stakes question in this repo, and it is a question only a real
// Postgres can answer — every one of the failure modes worth catching (a
// missing IF NOT EXISTS, a NOT NULL with no default, a foreign key added over
// a dangling id, a backfill INSERT that hits a not-null column) is a server
// behaviour, not a string a static check could spot.
//
// So this file boots the repo's embedded-postgres dev dependency and does
// three things in order:
//
//   1. FRESH BOOT. Apply the whole chain to an empty database, through the
//      real db/migrate.js. This is what a new environment does.
//
//   2. THE UPGRADE, WHICH IS THE ONE THAT SHIPS. Stop the chain one file short
//      of the new work, seed the database with the rows production actually
//      holds — including the orphan rows that are the reason 042 exists — and
//      then apply the remaining files on top. This is a deploy.
//
//   3. REPLAY. Wipe schema_migrations and run the ENTIRE chain again against
//      that same populated database. Every file therefore executes a second
//      time over live data, which is the property "idempotent and safe against
//      a production database that already has data" actually means. A file
//      that only works on an empty database passes step 1 and fails here.
//
// It then asserts the account-deletion invariant the new constraints exist
// for: after DELETE FROM users, nothing anywhere still holds that person's id.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('migrationBootSafety');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// The files this suite holds back in step 2 so it can apply them to a
// populated database rather than an empty one. Named rather than computed as
// "the last N" so that adding 044 does not silently change what is tested.
const DEPLOY_FILES = [
  '040_venue_tier_grants.sql',      // its backfill must meet a populated venue_profiles
  '042_dm_pair_ownership.sql',
  '043_query_health_indexes.sql',
];

let pg;
let pool;
let dataDir;
let migrate;

// The people. Two real accounts in a conversation, plus one that has already
// been deleted (its id is what the orphan rows point at).
const ALICE = 'alice.bootsafety@example.com';
const BOB = 'bob.bootsafety@example.com';
const VENUE_OWNER = 'owner.bootsafety@example.com';
const GHOST_ID = 999001; // never inserted into users

let aliceId;
let bobId;
let ownerId;

async function insertUser(email, name) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password) VALUES ($1, $2, 'x') RETURNING id`,
    [name, email]
  );
  return rows[0].id;
}

const count = async (sql, params = []) =>
  Number((await pool.query(sql, params)).rows[0].n);

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-bootsafety-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'migrationBootSafety', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_bootsafety_test');

  pool = new Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_bootsafety_test`,
  });
  ({ migrate } = require('../db/migrate'));
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------------------------------------------------------------------------
// 1. FRESH BOOT
// ---------------------------------------------------------------------------

test('the chain applies to an empty database, minus the files this suite holds back', async () => {
  // Pre-claiming the held-back names in schema_migrations is how they are held
  // back: the runner skips any file already recorded. No file is moved or
  // edited, so the thing under test in step 2 is the real file at its real
  // number, applied by the real runner.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`
  );
  for (const f of DEPLOY_FILES) {
    assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, f)), `${f} must exist`);
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  }

  await migrate(pool);

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
  );
  // 001 is `-- @tolerant` and is deliberately NOT recorded when any of its
  // statements are skipped, so it is the one file allowed to be missing here.
  const missing = files.filter((f) => !applied.has(f) && f !== '001_baseline.sql');
  assert.deepEqual(missing, [], 'every non-tolerant migration must record itself as applied');
});

// ---------------------------------------------------------------------------
// 2. THE UPGRADE — the new files meet a database that already has rows,
//    including the ones that would break them.
// ---------------------------------------------------------------------------

test('042 meets the orphan rows it exists to clean, and does not fail the boot on them', async () => {
  aliceId = await insertUser(ALICE, 'Alice');
  bobId = await insertUser(BOB, 'Bob');
  ownerId = await insertUser(VENUE_OWNER, 'Owner');

  // A live conversation between two accounts that both exist.
  await pool.query(
    `INSERT INTO dm_venue_votes (user1_id, user2_id, user_id, venue_name, venue_id)
     VALUES ($1, $2, $1, 'Live Bar', 'ChIJlive'), ($1, $2, $3, 'Live Bar', 'ChIJlive')`,
    [Math.min(aliceId, bobId), Math.max(aliceId, bobId), Math.max(aliceId, bobId)]
  );
  await pool.query(
    `INSERT INTO dm_pinned_venues (user1_id, user2_id, venue_name, venue_address, pinned_by)
     VALUES ($1, $2, 'Live Bar', '1 Live St', $1)`,
    [Math.min(aliceId, bobId), Math.max(aliceId, bobId)]
  );

  // And the residue of a conversation whose other half deleted their account
  // before the constraint existed. This is the exact shape production holds:
  // the row survived, still naming a user id that is gone, still carrying the
  // venue's name and street address.
  await pool.query(
    `INSERT INTO dm_venue_votes (user1_id, user2_id, user_id, venue_name, venue_id)
     VALUES ($1, $2, $2, 'Orphan Bar', 'ChIJorphan')`,
    [GHOST_ID, bobId]
  );
  await pool.query(
    `INSERT INTO dm_pinned_venues (user1_id, user2_id, venue_name, venue_address, pinned_by)
     VALUES ($1, $2, 'Orphan Bar', '9 Orphan Row', NULL)`,
    [GHOST_ID, bobId]
  );

  // A paid venue profile, so 040's backfill has something to backfill and 042
  // is not the only file meeting live data.
  await pool.query(
    `INSERT INTO venue_profiles (user_id, business_name, tier, google_place_id)
     VALUES ($1, 'The Test Room', 'premium', 'ChIJownerplace')`,
    [ownerId]
  );

  assert.equal(await count('SELECT COUNT(*) AS n FROM dm_pinned_venues'), 2);

  // Now the deploy: release the held-back files and run the runner again.
  await pool.query('DELETE FROM schema_migrations WHERE name = ANY($1)', [DEPLOY_FILES]);
  await migrate(pool); // must not throw — a throw here is production down

  assert.equal(
    await count(`SELECT COUNT(*) AS n FROM dm_pinned_venues WHERE user1_id = $1 OR user2_id = $1`, [GHOST_ID]),
    0, '042 must remove the pinned-venue rows that name a user who no longer exists'
  );
  assert.equal(
    await count(`SELECT COUNT(*) AS n FROM dm_venue_votes WHERE user1_id = $1 OR user2_id = $1`, [GHOST_ID]),
    0, '042 must remove the vote rows that name a user who no longer exists'
  );
  assert.equal(
    await count('SELECT COUNT(*) AS n FROM dm_pinned_venues'), 1,
    'and it must not touch the conversation whose participants both still exist'
  );
  assert.equal(await count('SELECT COUNT(*) AS n FROM dm_venue_votes'), 2);
});

test('the pair columns are now real foreign keys that cascade', async () => {
  const { rows } = await pool.query(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype
       FROM pg_constraint c
       JOIN unnest(c.conkey) AS k(attnum) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f'
        AND c.confrelid = 'users'::regclass
        AND c.conrelid IN ('dm_venue_votes'::regclass, 'dm_pinned_venues'::regclass)`
  );
  const got = new Set(rows.map((r) => `${r.tbl}.${r.col}`));
  for (const want of [
    'dm_venue_votes.user1_id', 'dm_venue_votes.user2_id',
    'dm_pinned_venues.user1_id', 'dm_pinned_venues.user2_id',
  ]) {
    assert.ok(got.has(want), `${want} must reference users(id)`);
  }
  for (const r of rows) {
    // 'c' is ON DELETE CASCADE. user1/user2 must cascade; pinned_by ('n', SET
    // NULL) is a different column and is not in this result set.
    if (/user[12]_id$/.test(r.col)) {
      assert.equal(r.confdeltype, 'c', `${r.tbl}.${r.col} must be ON DELETE CASCADE`);
    }
  }
});

test('043 built every index it names, and none of them landed INVALID', async () => {
  const names = [
    'idx_venue_owner_reports_diverged',
    'idx_emergency_alerts_user_created',
    'idx_venue_sensor_data_device_recorded',
    'idx_venue_reviews_place_created',
    'idx_venue_reviews_user',
    'idx_emoji_reactions_user',
    // 042's, which are ordinary non-concurrent builds
    'idx_dm_venue_votes_user2', 'idx_dm_venue_votes_user',
    'idx_dm_pinned_user2', 'idx_dm_pinned_pinned_by',
  ];
  const { rows } = await pool.query(
    `SELECT c.relname, i.indisvalid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
    [names]
  );
  const byName = Object.fromEntries(rows.map((r) => [r.relname, r.indisvalid]));
  for (const n of names) {
    assert.ok(n in byName, `index ${n} was not created`);
    assert.equal(byName[n], true, `index ${n} exists but is INVALID, so the planner will never use it`);
  }
});

test("040's backfill wrote the venue grant, once", async () => {
  const { rows } = await pool.query(
    'SELECT tier, source, granted_reason, expires_at FROM venue_subscriptions WHERE user_id = $1',
    [ownerId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 'premium');
  assert.equal(rows[0].granted_reason, 'legacy_grant');
  assert.equal(rows[0].expires_at, null, 'a hand-granted tier had no end date agreed and must not gain one');
});

test("040 does not fail the boot on a venue profile with no owner", async () => {
  // venue_profiles.user_id is UNIQUE, which means NULLABLE, while
  // venue_subscriptions.user_id is a PRIMARY KEY. Without the IS NOT NULL
  // guard the SELECT hands a NULL to a not-null column, the migration throws,
  // and the boot dies on a backfill row nothing was reading.
  await pool.query(
    `INSERT INTO venue_profiles (user_id, business_name, tier)
     VALUES (NULL, 'Ownerless Room', 'pro')`
  );
  await pool.query(`DELETE FROM schema_migrations WHERE name = '040_venue_tier_grants.sql'`);
  await migrate(pool); // must not throw
  assert.equal(
    await count('SELECT COUNT(*) AS n FROM venue_subscriptions'), 1,
    'the ownerless profile is skipped, not inserted, and not fatal'
  );
  await pool.query(`DELETE FROM venue_profiles WHERE user_id IS NULL`);
});

// ---------------------------------------------------------------------------
// 3. REPLAY — every file, a second time, over live data
// ---------------------------------------------------------------------------

test('the whole chain replays over a populated database without throwing', async () => {
  const before = {
    users: await count('SELECT COUNT(*) AS n FROM users'),
    votes: await count('SELECT COUNT(*) AS n FROM dm_venue_votes'),
    pins: await count('SELECT COUNT(*) AS n FROM dm_pinned_venues'),
    subs: await count('SELECT COUNT(*) AS n FROM venue_subscriptions'),
    profiles: await count('SELECT COUNT(*) AS n FROM venue_profiles'),
  };

  await pool.query('DELETE FROM schema_migrations');
  await migrate(pool); // THE assertion: a second pass must not fail the boot

  assert.deepEqual({
    users: await count('SELECT COUNT(*) AS n FROM users'),
    votes: await count('SELECT COUNT(*) AS n FROM dm_venue_votes'),
    pins: await count('SELECT COUNT(*) AS n FROM dm_pinned_venues'),
    subs: await count('SELECT COUNT(*) AS n FROM venue_subscriptions'),
    profiles: await count('SELECT COUNT(*) AS n FROM venue_profiles'),
  }, before, 'a replay must not add, duplicate or destroy a single row');
});

// ---------------------------------------------------------------------------
// 4. THE SWALLOWED FAILURE. A migration that ran, did nothing, and said it was
//    done.
// ---------------------------------------------------------------------------
//
// 032 and 038 wrapped every ALTER TABLE in `DO $$ ... EXCEPTION WHEN others
// THEN NULL`. db/migrate.js arms lock_timeout at 10 seconds on purpose, so DDL
// cannot queue behind a long query during a rolling deploy. Those two facts
// together were the bug: the timeout fired, `others` ate it, the batch returned
// cleanly, and the runner wrote the schema_migrations row. Nothing re-runs a
// migration the runner believes is done, so the columns routes/crowd.js and
// routes/feedback.js write were absent permanently and a redeploy did not heal
// it. The two tests below are the lock and the key.

const COLUMNS_032 = [
  ['venue_feedback', 'predicted_score_source'],
  ['venue_feedback', 'client_predicted_score'],
  ['venue_feedback', 'served_prediction_id'],
];
const COLUMNS_038 = [
  ['served_predictions', 'source'],
  ['served_predictions', 'local_day'],
  ['served_predictions', 'local_hour'],
];

async function columnExists(table, column) {
  return (await count(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column]
  )) === 1;
}

async function dropColumns(table, columns) {
  await pool.query(
    `ALTER TABLE ${table} ` + columns.map((c) => `DROP COLUMN IF EXISTS ${c}`).join(', ')
  );
}

test('neither 032 nor 038 may go back to catching `others`', async () => {
  // The narrowing is the fix. A future edit that widens it again puts the
  // permanent-data-loss failure mode straight back, and the two tests after
  // this one would still pass, because a swallowed timeout looks like success.
  for (const f of ['032_served_predictions.sql', '038_served_prediction_provenance.sql']) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const code = sql.replace(/^[ \t]*--[^\n]*$/gm, ''); // the headers discuss `others` at length
    assert.equal(
      /EXCEPTION\s+WHEN\s+others/i.test(code), false,
      `${f} must not catch \`others\`: it cannot tell a lock timeout from an existing column`
    );
    assert.ok(
      /^[ \t]*--[ \t]*@requires[ \t]/m.test(sql),
      `${f} must declare what it requires so the runner can verify it landed`
    );
  }
});

test('a lock timeout during 032 fails the boot instead of being recorded as applied', async () => {
  // The exact production shape: the columns are not there yet, and something
  // else is holding the table when the deploy lands.
  await dropColumns('venue_feedback', COLUMNS_032.map(([, c]) => c));
  await pool.query(`DELETE FROM schema_migrations WHERE name = '032_served_predictions.sql'`);

  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE venue_feedback IN ACCESS EXCLUSIVE MODE');

    // Takes lock_timeout (10s) to come back, which is the point: the runner
    // waits, gives up, and must not call that success.
    await assert.rejects(
      migrate(pool),
      (err) => /lock|timeout|032_served_predictions/i.test(err.message),
      'the runner must surface the lock timeout rather than swallowing it'
    );

    assert.equal(
      await count(
        `SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '032_served_predictions.sql'`
      ), 0,
      'a migration whose ALTER never ran must NOT be recorded as applied, or nothing will ever retry it'
    );
    for (const [t, c] of COLUMNS_032) {
      assert.equal(await columnExists(t, c), false, `${t}.${c} cannot exist yet`);
    }
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }

  // And the recovery a restart gives you, which is the whole reason failing is
  // better than pretending: the next boot simply applies it.
  await migrate(pool);
  assert.equal(
    await count(`SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '032_served_predictions.sql'`),
    1
  );
  for (const [t, c] of COLUMNS_032) {
    assert.ok(await columnExists(t, c), `${t}.${c} must exist after the retry`);
  }
});

test('a database already mismarked as having 032 and 038 heals itself on boot', async () => {
  // Some databases were migrated before the narrowing, so they may already hold
  // the broken state the test above now prevents: the row in schema_migrations,
  // and no columns. There is no boot path out of that on its own, so the runner
  // re-verifies the declared post-conditions of applied files and replays the
  // ones that do not hold.
  await pool.query(
    `INSERT INTO served_predictions (user_id, venue_place_id, score, source, local_day, local_hour)
     VALUES ($1, 'ChIJheal', 61, 'detail', 5, 22)`,
    [bobId]
  );

  // A healthy boot first: nothing is replayed, nothing is touched.
  const stamps = async () => (await pool.query(
    `SELECT name, applied_at FROM schema_migrations
      WHERE name IN ('032_served_predictions.sql', '038_served_prediction_provenance.sql')
      ORDER BY name`
  )).rows;
  const before = await stamps();
  assert.equal(before.length, 2);
  await migrate(pool);
  assert.deepEqual(await stamps(), before, 'a healthy database must not have its migrations re-run');

  // Now the damage, with both files left recorded as applied.
  await dropColumns('venue_feedback', COLUMNS_032.map(([, c]) => c));
  await dropColumns('served_predictions', COLUMNS_038.map(([, c]) => c));
  for (const [t, c] of [...COLUMNS_032, ...COLUMNS_038]) {
    assert.equal(await columnExists(t, c), false);
  }
  assert.equal((await stamps()).length, 2, 'the false records are what make this unrecoverable');

  await migrate(pool); // must not throw: this is a boot

  for (const [t, c] of [...COLUMNS_032, ...COLUMNS_038]) {
    assert.ok(await columnExists(t, c), `${t}.${c} must be restored by the self-heal`);
  }
  assert.equal((await stamps()).length, 2, 'and both files must end up recorded again');
  assert.equal(
    await count(`SELECT COUNT(*) AS n FROM served_predictions WHERE venue_place_id = 'ChIJheal'`),
    1, 'the repair must not take the serve log with it'
  );

  await pool.query(`DELETE FROM served_predictions WHERE venue_place_id = 'ChIJheal'`);
});

// ---------------------------------------------------------------------------
// THE INVARIANT ALL OF THIS IS FOR
// ---------------------------------------------------------------------------

test('deleting an account leaves nothing of that account behind', async () => {
  const pair = [Math.min(aliceId, bobId), Math.max(aliceId, bobId)];
  assert.ok(await count(
    'SELECT COUNT(*) AS n FROM dm_pinned_venues WHERE user1_id = $1 AND user2_id = $2', pair
  ) > 0, 'the fixture must exist before it can be proven gone');

  await pool.query('DELETE FROM users WHERE id = $1', [aliceId]);

  assert.equal(
    await count('SELECT COUNT(*) AS n FROM dm_pinned_venues WHERE user1_id = $1 OR user2_id = $1', [aliceId]),
    0, 'a deleted account must not survive in dm_pinned_venues, which also holds the venue address'
  );
  assert.equal(
    await count('SELECT COUNT(*) AS n FROM dm_venue_votes WHERE user1_id = $1 OR user2_id = $1', [aliceId]),
    0, "and must not survive in the other party's vote rows for that conversation"
  );
  // The conversation is gone in full, not half of it: Bob's own vote in the
  // same pair went with it, because the pair is what was deleted.
  assert.equal(await count('SELECT COUNT(*) AS n FROM dm_venue_votes'), 0);
});

test('no table with a user-identifying column is left without a foreign key', async () => {
  // The catalog, not the source: this is the check that would have caught
  // dm_venue_votes and dm_pinned_venues on the day they were written, and it
  // is what stops the next table keyed to a raw integer user id from shipping.
  const { rows } = await pool.query(
    `SELECT c.relname AS tbl, a.attname AS col
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attname ~ '^(user[0-9]?_id|.*_user_id|reporter_id|reported_user_id|blocker_id|blocked_id|sender_id|receiver_id|requester_id|addressee_id|creator_id|moderator_id|target_user_id|pinned_by|paid_by|granted_by|handled_by|created_by)$'
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint fk
           WHERE fk.contype = 'f' AND fk.conrelid = c.oid
             AND a.attnum = ANY (fk.conkey)
             AND fk.confrelid = 'users'::regclass)
      ORDER BY 1, 2`
  );
  // ml_* tables are a batch-rebuilt corpus with no user column; nothing else
  // is expected here. An addition to this list needs a reason written next to
  // it, not a silent append.
  assert.deepEqual(
    rows.map((r) => `${r.tbl}.${r.col}`), [],
    'a column naming a user has no foreign key to users(id), so an account deletion will orphan it'
  );
});
