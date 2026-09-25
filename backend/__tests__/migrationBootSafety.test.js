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
// 064 AND WHO AN SOS REACHED. The one backfill in the chain keyed on a ledger
// timestamp, which is the one thing a replay rewrites.
// ---------------------------------------------------------------------------
//
// 064 marks alerts written before 063 as legacy, NULL recipients, so their
// stand-down falls back to the live audience, and makes an empty array mean
// "nobody". Its cutoff is 063's applied_at, and the replay in section 3
// records 063 again at the moment it runs. Before 064 learned to run its
// backfill once, that pass turned every recorded audience into NULL: the rows
// seeded here are held up against the replay below.

const alertRecipients = async () => (await pool.query(
  'SELECT id, flock_recipient_ids, contact_recipients FROM emergency_alerts ORDER BY id'
)).rows;

test('064 on its first application marks only the alerts from before 063, and only when they name no one', async () => {
  // 063's post-state, which is the state 064 met everywhere it first ran: both
  // columns NOT NULL with the empty defaults. Nothing earlier in this file
  // writes an alert, so no NULL stands in the way of the constraint.
  await pool.query(
    `ALTER TABLE emergency_alerts
       ALTER COLUMN flock_recipient_ids SET DEFAULT '{}',
       ALTER COLUMN flock_recipient_ids SET NOT NULL,
       ALTER COLUMN contact_recipients SET DEFAULT '[]'::jsonb,
       ALTER COLUMN contact_recipients SET NOT NULL`
  );
  await pool.query(
    `UPDATE schema_migrations SET applied_at = NOW() - INTERVAL '1 day'
      WHERE name = '063_emergency_alert_recipients.sql'`
  );
  // From before 063: the defaults are all it has.
  const legacy = (await pool.query(
    `INSERT INTO emergency_alerts (user_id, latitude, longitude, contacts_alerted, created_at)
     VALUES ($1, 0, 0, 1, (NOW() - INTERVAL '2 days')::timestamp) RETURNING id`,
    [bobId]
  )).rows[0].id;
  // From after it, the two shapes routes/safety.js writes: an alarm that
  // reached a flockmate and a contact, and one that reached nobody at all.
  const contact = [{ name: 'Sam', email: 'sam.bootsafety@example.com' }];
  const reached = (await pool.query(
    `INSERT INTO emergency_alerts (user_id, latitude, longitude, contacts_alerted, flock_recipient_ids, contact_recipients)
     VALUES ($1, 0, 0, 1, ARRAY[$2]::int[], $3::jsonb) RETURNING id`,
    [bobId, ownerId, JSON.stringify(contact)]
  )).rows[0].id;
  const nobody = (await pool.query(
    `INSERT INTO emergency_alerts (user_id, latitude, longitude, contacts_alerted, flock_recipient_ids, contact_recipients)
     VALUES ($1, 0, 0, 0, '{}'::int[], '[]'::jsonb) RETURNING id`,
    [bobId]
  )).rows[0].id;

  await pool.query(`DELETE FROM schema_migrations WHERE name = '064_emergency_alert_snapshot_sentinel.sql'`);
  await migrate(pool);

  const byId = Object.fromEntries((await alertRecipients()).map((r) => [r.id, r]));
  assert.deepEqual(
    [byId[legacy].flock_recipient_ids, byId[legacy].contact_recipients], [null, null],
    'an alert from before 063 has no snapshot, so it must read as legacy'
  );
  assert.deepEqual(
    [byId[reached].flock_recipient_ids, byId[reached].contact_recipients], [[ownerId], contact],
    'an alert that recorded who it reached keeps that record'
  );
  assert.deepEqual(
    [byId[nobody].flock_recipient_ids, byId[nobody].contact_recipients], [[], []],
    'an alert from after 063 that reached nobody is authoritative, not legacy'
  );
  const { rows: cols } = await pool.query(
    `SELECT attname, attnotnull, atthasdef FROM pg_attribute
      WHERE attrelid = 'emergency_alerts'::regclass
        AND attname IN ('flock_recipient_ids', 'contact_recipients')
      ORDER BY attname`
  );
  assert.deepEqual(
    cols.map((c) => [c.attname, c.attnotnull, c.atthasdef]),
    [['contact_recipients', false, false], ['flock_recipient_ids', false, false]],
    'NULL has to be storable and nothing may default it away'
  );
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
  const alertsBefore = await alertRecipients();
  assert.equal(alertsBefore.length, 3, 'the SOS rows seeded for 064 must be here to be checked');
  // An audit row only 020's list allows, the kind production writes on every
  // verification. A replay reaches 017 first, which re-adds the narrower list;
  // it did that validated and failed the boot on this row until it went NOT
  // VALID.
  const { rows: [audit] } = await pool.query(
    `INSERT INTO moderation_actions (moderator_id, target_user_id, action, content_type, content_id)
     VALUES (NULL, NULL, 'venue_verified', 'venue_profile', 0) RETURNING id`
  );

  await pool.query('DELETE FROM schema_migrations');
  await migrate(pool); // THE assertion: a second pass must not fail the boot
  const { rows: auditAfter } = await pool.query('SELECT action FROM moderation_actions WHERE id = $1', [audit.id]);
  assert.deepEqual(auditAfter.map((r) => r.action), ['venue_verified'], 'the replay moved the verification audit row');
  await pool.query('DELETE FROM moderation_actions WHERE id = $1', [audit.id]);

  assert.deepEqual({
    users: await count('SELECT COUNT(*) AS n FROM users'),
    votes: await count('SELECT COUNT(*) AS n FROM dm_venue_votes'),
    pins: await count('SELECT COUNT(*) AS n FROM dm_pinned_venues'),
    subs: await count('SELECT COUNT(*) AS n FROM venue_subscriptions'),
    profiles: await count('SELECT COUNT(*) AS n FROM venue_profiles'),
  }, before, 'a replay must not add, duplicate or destroy a single row');
  // Nor rewrite one. 063 is recorded again at this moment, so a backfill keyed
  // on its timestamp sees every alert ever written as "from before 063".
  assert.deepEqual(
    await alertRecipients(), alertsBefore,
    'a replay must not change who an SOS reached: a recorded audience that became NULL would send the ' +
    'all-clear to the live flock and contact list, people who never received the alarm'
  );
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
// 5. THE HEAL UNDER CONTENTION. The repair that turned a degraded boot into an
//    outage.
// ---------------------------------------------------------------------------
//
// The heal above is the only thing that can recover a falsely-marked database,
// and the first version of it deleted the schema_migrations row in autocommit,
// BEFORE the re-apply transaction opened, for every unsatisfied file at once.
// Measured on this same embedded Postgres with a second connection holding
// `LOCK TABLE venue_feedback IN ACCESS EXCLUSIVE MODE`, which is the rolling
// deploy the 10s lock_timeout exists for:
//
//   before the heal shipped   returned in 23ms      degraded, serving
//   with that heal            threw after 10,020ms  server.listen() never runs
//   and boots 2 and 3         threw, row now GONE   permanently unbootable
//
// A heal repairs a database that is already broken, so the one thing it may
// never do is make it worse. This test is that property: contention costs the
// repair, not the row, not the boot, and not the other files.

const COLUMNS_045 = [
  ['ml_training_data', 'events_observed'],
  ['ml_training_data', 'events_unavailable_reason'],
];

const migrationRowCount = (file) =>
  count('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = $1', [file]);

test('a heal that cannot get its lock still boots, keeps the row, and repairs the other files', async () => {
  // The starting state is the one production was in: both files recorded as
  // applied, their columns gone. Two files, on two different tables, so a
  // failure on one is visibly not a failure on the other.
  await dropColumns('venue_feedback', COLUMNS_032.map(([, c]) => c));
  await dropColumns('ml_training_data', COLUMNS_045.map(([, c]) => c));
  assert.equal(await migrationRowCount('032_served_predictions.sql'), 1);
  assert.equal(await migrationRowCount('045_ml_event_provenance.sql'), 1);

  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE venue_feedback IN ACCESS EXCLUSIVE MODE');

    // Two boots, because the old failure only showed its full shape on the
    // second one: the first deleted the row, and every boot after it found
    // nothing to heal and nothing to re-apply.
    for (const boot of [1, 2]) {
      const started = Date.now();
      await migrate(pool); // MUST NOT THROW. A throw here is server.listen() never reached.
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 60_000, `boot ${boot} took ${elapsed}ms, which is not a boot any platform waits for`);

      assert.equal(
        await migrationRowCount('032_served_predictions.sql'), 1,
        `boot ${boot}: a repair that could not run must leave schema_migrations exactly as it found it`
      );
      for (const [t, c] of COLUMNS_032) {
        assert.equal(await columnExists(t, c), false, `boot ${boot}: ${t}.${c} is still blocked, as expected`);
      }
      // The cascade that must not happen: 045 requires columns on a table
      // nothing is holding, so it is repaired on boot 1 and left alone after.
      assert.equal(await migrationRowCount('045_ml_event_provenance.sql'), 1);
      for (const [t, c] of COLUMNS_045) {
        assert.ok(await columnExists(t, c), `boot ${boot}: ${t}.${c} must be repaired despite the lock on another table`);
      }
    }
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }

  // And the recovery, which only exists because the row survived: the next
  // boot after the contention clears finishes the repair on its own.
  await migrate(pool);
  for (const [t, c] of COLUMNS_032) {
    assert.ok(await columnExists(t, c), `${t}.${c} must be restored once the lock is gone`);
  }
  assert.equal(await migrationRowCount('032_served_predictions.sql'), 1, 'and recorded exactly once, still');
});

// ---------------------------------------------------------------------------
// 6. THE EDITED MIGRATION. The drift no suite could see, because every suite
//    runs the chain and production ran the FILE, once, as it stood that hour.
// ---------------------------------------------------------------------------
//
// 003 was applied to production at 2026-08-13 07:06 UTC and EDITED afterwards:
// rounds 6 and 7 appended the venue_reviews / venue_promotions is_hidden
// ALTERs to a file the runner had already recorded. Every fresh database got
// the columns; production alone did not, and from round 18 (2026-08-14) every
// statement filtering on them answered 42703 there — the owner Reviews tab,
// both public card reads, the owner reply, the promotion edit, the admin
// queue, and the moderation hide for both types. A week of 500s that this
// whole suite stayed green through, which is the point of this section: the
// chain being correct proves nothing about a database that ran an older copy
// of one of its files. 048 re-states the two ALTERs in a new file, with
// @requires, and this is the test that 048 actually reaches such a database.

const COLUMNS_048 = [
  ['venue_reviews', 'is_hidden'],
  ['venue_promotions', 'is_hidden'],
];

test("048 reaches a database that applied 003 before the is_hidden ALTERs existed", async () => {
  // Production's exact shape on 2026-08-21, reconstructed twice over. First as
  // the deploy that ships the fix: 003 recorded, the columns absent, 048 not
  // yet applied — the runner must apply it as an ordinary pending file.
  await dropColumns('venue_reviews', ['is_hidden']);
  await dropColumns('venue_promotions', ['is_hidden']);
  await pool.query(`DELETE FROM schema_migrations WHERE name = '048_restore_ugc_takedown_columns.sql'`);
  for (const [t, c] of COLUMNS_048) {
    assert.equal(await columnExists(t, c), false, `${t}.${c} must start absent, as production had it`);
  }

  await migrate(pool); // the deploy

  assert.equal(await migrationRowCount('048_restore_ugc_takedown_columns.sql'), 1);
  for (const [t, c] of COLUMNS_048) {
    assert.ok(await columnExists(t, c), `${t}.${c} must exist after the deploy that carries 048`);
  }

  // Second, as a later loss with 048 already recorded: @requires means the
  // self-heal notices on the next boot instead of a route noticing with a 500.
  await dropColumns('venue_reviews', ['is_hidden']);
  await dropColumns('venue_promotions', ['is_hidden']);
  assert.equal(await migrationRowCount('048_restore_ugc_takedown_columns.sql'), 1);

  await migrate(pool); // a boot

  for (const [t, c] of COLUMNS_048) {
    assert.ok(await columnExists(t, c), `${t}.${c} must be healed while 048 stays recorded once`);
  }
  assert.equal(await migrationRowCount('048_restore_ugc_takedown_columns.sql'), 1);

  // And the statement that was answering 42703 in production — the stats read
  // of GET /api/venue-dashboard/reviews — now parses and runs.
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total, AVG(vr.rating)::float AS average
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
      WHERE vr.google_place_id = $1
        AND COALESCE(vr.is_hidden, false) = false`,
    ['ChIJbootsafety048']
  );
  assert.equal(rows[0].total, 0, 'the reviews stats statement must run, not 42703');
});

// ---------------------------------------------------------------------------
// 7. THE SWALLOW AGAIN, ON A CHECK CONSTRAINT. 067 and the repair in 081.
// ---------------------------------------------------------------------------
//
// 067 widened messages.message_type to admit 'system' inside the same
// `EXCEPTION WHEN others` section 4 is about, so under the runner's
// lock_timeout the widening can give up in silence. When the conflicting lock
// then clears before 067's next ALTER times out too, the file commits and is
// recorded, and nothing ever runs it again. Measured with the runner itself
// and a second connection holding ACCESS SHARE on messages for 13 seconds:
// 067 recorded, the old CHECK in place, the system row refused with 23514.
// That takes two lock timeouts of real time, so the test below proves the
// swallow with 067's own DO block under a short lock_timeout, and the repair
// with the runner.

// utils/systemMessages.js writeSystemMessage, verbatim: the one statement that
// writes a system row.
const SYSTEM_ROW_INSERT = `INSERT INTO messages (flock_id, sender_id, message_text, message_type, system_kind)
       VALUES ($1, $2, $3, 'system', $4)
       RETURNING *`;

async function messageTypeCheck() {
  const { rows } = await pool.query(
    `SELECT oid, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'messages'::regclass AND conname = 'messages_message_type_check'`
  );
  return rows[0] || null;
}

test("067 can give up on its CHECK in silence, and 081 repairs a database where it did", async () => {
  // The CHECK every database had before 067: three values, no 'system'.
  await pool.query('ALTER TABLE messages DROP CONSTRAINT messages_message_type_check');
  await pool.query(
    `ALTER TABLE messages ADD CONSTRAINT messages_message_type_check
       CHECK (message_type IN ('text', 'venue_card', 'image'))`
  );

  // 067's own DO block while another connection holds a lock on messages.
  // 300ms of lock_timeout is the runner's 10 seconds without the wait.
  const sql067 = fs.readFileSync(path.join(MIGRATIONS_DIR, '067_flock_system_messages.sql'), 'utf8');
  const widen = /DO \$\$ BEGIN[\s\S]*?END \$\$;/.exec(sql067);
  assert.ok(widen && /EXCEPTION WHEN others/.test(widen[0]), "067's widening is the DO block under test");
  const blocker = await pool.connect();
  const runner = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE messages IN ACCESS SHARE MODE');
    await runner.query("SET lock_timeout = '300ms'");
    await runner.query(widen[0]); // returns cleanly, which is the defect
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    await runner.query('RESET lock_timeout').catch(() => {});
    runner.release();
  }
  assert.doesNotMatch(
    (await messageTypeCheck()).def, /'system'/,
    'the lock timeout was caught as if it were success, and the CHECK was never widened'
  );

  const flockId = (await pool.query(
    `INSERT INTO flocks (name, creator_id) VALUES ('Boot safety 081', $1) RETURNING id`, [bobId]
  )).rows[0].id;
  try {
    // That database cannot store the row a venue confirmation writes...
    await assert.rejects(
      pool.query(SYSTEM_ROW_INSERT, [flockId, bobId, 'Kome', 'venue_set']),
      (err) => err.code === '23514',
      'a system row must be refused by the three-value CHECK, which is the production symptom'
    );

    // ...until the deploy that carries 081, with 067 still recorded as done.
    assert.equal(await migrationRowCount('067_flock_system_messages.sql'), 1);
    await pool.query(`DELETE FROM schema_migrations WHERE name = '081_system_message_type_check.sql'`);
    await migrate(pool);
    assert.equal(await migrationRowCount('081_system_message_type_check.sql'), 1);
    const repaired = await messageTypeCheck();
    assert.match(repaired.def, /'system'/);
    assert.equal(repaired.convalidated, true, 'VALIDATE ran, so every existing row is known to satisfy it');
    const { rows } = await pool.query(SYSTEM_ROW_INSERT, [flockId, bobId, 'Kome', 'venue_set']);
    assert.equal(rows[0].message_type, 'system');

    // A second pass changes nothing: the same constraint, not one dropped and
    // re-added under ACCESS EXCLUSIVE on every replay.
    await pool.query(`DELETE FROM schema_migrations WHERE name = '081_system_message_type_check.sql'`);
    await migrate(pool);
    assert.equal(await migrationRowCount('081_system_message_type_check.sql'), 1);
    assert.equal((await messageTypeCheck()).oid, repaired.oid, 'a healthy database had its CHECK rebuilt');
  } finally {
    await pool.query('DELETE FROM flocks WHERE id = $1', [flockId]);
  }
});

test('081 widens NOT VALID, validates in a statement of its own, and catches nothing', () => {
  // The shape is the fix. A validating ADD holds ACCESS EXCLUSIVE on messages
  // for a whole-table scan, VALIDATE in the same transaction would hold it
  // just as long, and a handler that catches a lock timeout is how 067 went
  // wrong in the first place.
  const { splitStatements } = require('../db/migrate');
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '081_system_message_type_check.sql'), 'utf8');
  assert.ok(sql.startsWith('-- @noTransaction'), 'each statement must commit on its own');
  const code = sql.replace(/^[ \t]*--[^\n]*$/gm, '');
  assert.equal(/EXCEPTION\s+WHEN/i.test(code), false, '081 must not catch anything');
  const stmts = splitStatements(sql).map((s) => s.replace(/^[ \t]*--[^\n]*$/gm, '').trim());
  const add = stmts.findIndex((s) => /ADD CONSTRAINT messages_message_type_check[\s\S]*\bNOT VALID\b/.test(s));
  const validate = stmts.findIndex((s) => /^ALTER TABLE messages VALIDATE CONSTRAINT messages_message_type_check$/.test(s));
  assert.ok(add >= 0, 'the widening is added NOT VALID');
  assert.ok(validate > add, 'and validated afterwards, in its own statement');
});

// ---------------------------------------------------------------------------
// 8. 082 AND THE READINGS ALREADY STORED TWICE.
// ---------------------------------------------------------------------------
//
// 082 makes (sensor_device_id, recorded_at) unique on venue_sensor_data, and a
// database from before it may hold the copies two racing deliveries of one
// reading left behind. The deploy must not fail on them, must keep the first
// copy of each reading and nothing else, and a second pass must move nothing.

const READING_KEY = 'venue_sensor_data_reading_key';
const sensorRows = async () => (await pool.query(
  `SELECT id, sensor_device_id, recorded_at, ir_beam_count FROM venue_sensor_data
    WHERE venue_place_id = 'ChIJbootsafety082' ORDER BY id`
)).rows;
const readingKey = async () => (await pool.query(
  `SELECT i.indexrelid::int AS oid, i.indisunique, i.indisvalid, pg_get_indexdef(i.indexrelid) AS def
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = $1`, [READING_KEY]
)).rows[0] || null;
const storeReading = async (device, stamp, ir) => (await pool.query(
  `INSERT INTO venue_sensor_data (venue_place_id, ir_beam_count, thermal_headcount, noise_db, sensor_device_id, recorded_at)
   VALUES ('ChIJbootsafety082', $3, 5, 61.5, $1, $2::timestamptz) RETURNING id`,
  [device, stamp, ir]
)).rows[0].id;

test('082 meets readings stored twice: it keeps the first copy of each, builds its key, and a replay moves nothing', async () => {
  // The database 082 meets: no key yet, and the copies are there.
  await pool.query(`DROP INDEX IF EXISTS ${READING_KEY}`);
  await pool.query(`DELETE FROM schema_migrations WHERE name = '082_sensor_reading_key.sql'`);
  const at = '2026-09-25T02:00:00.000Z';
  const first = await storeReading('sensor_a', at, 4);
  await storeReading('sensor_a', at, 4); // the racing delivery's copy
  await storeReading('sensor_a', at, 9); // a later delivery of the same stamp
  const next = await storeReading('sensor_a', '2026-09-25T02:00:30.500Z', 4);
  const otherDevice = await storeReading('sensor_b', at, 4);
  // A row with no stamp is nobody's copy, and two of them are two rows.
  const nulls = [await storeReading('sensor_a', null, 1), await storeReading('sensor_a', null, 1)];

  await migrate(pool); // the deploy: must not throw

  assert.deepEqual((await sensorRows()).map((r) => r.id), [first, next, otherDevice, ...nulls],
    'only the later copies of one device and one instant are removed, and the first is the one kept');
  assert.equal((await sensorRows())[0].ir_beam_count, 4, 'the copy kept is the one stored first');
  const key = await readingKey();
  assert.ok(key, `${READING_KEY} was not built`);
  assert.equal(key.indisunique, true);
  assert.equal(key.indisvalid, true, 'the key exists but is INVALID, so nothing is enforced');
  assert.match(key.def, /UNIQUE INDEX venue_sensor_data_reading_key ON (public\.)?venue_sensor_data USING btree \(sensor_device_id, recorded_at\)$/);
  await assert.rejects(storeReading('sensor_a', at, 4), (err) => err.code === '23505',
    'a second row for one device and instant must now be refused');

  // The replay: nothing to remove, nothing rebuilt.
  const before = await sensorRows();
  await pool.query(`DELETE FROM schema_migrations WHERE name = '082_sensor_reading_key.sql'`);
  await migrate(pool);
  assert.deepEqual(await sensorRows(), before, 'a second pass of 082 moved a row');
  assert.equal((await readingKey()).oid, key.oid, 'a healthy key was rebuilt');
  assert.equal(await migrationRowCount('082_sensor_reading_key.sql'), 1);
});

test('082 recovers on the next boot when a copy stored mid-deploy failed its build', async () => {
  // The old server stores a copy after 082's DELETE and before the build
  // enforces the key: the concurrent build fails on it and leaves an INVALID
  // index, and the boot fails without recording the file. That state is made
  // here with the same statement, and the next boot must repair it.
  await pool.query(`DROP INDEX IF EXISTS ${READING_KEY}`);
  await pool.query(`DELETE FROM schema_migrations WHERE name = '082_sensor_reading_key.sql'`);
  const at = '2026-09-25T03:00:00.000Z';
  const first = await storeReading('sensor_c', at, 7);
  await storeReading('sensor_c', at, 7);
  await assert.rejects(
    pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${READING_KEY} ON venue_sensor_data (sensor_device_id, recorded_at)`),
    (err) => err.code === '23505'
  );
  assert.equal((await readingKey()).indisvalid, false, 'the failed build must have left an INVALID index behind');

  await migrate(pool); // the restart: must not throw

  const key = await readingKey();
  assert.equal(key.indisvalid, true, 'the INVALID index from the failed build was kept instead of rebuilt');
  assert.equal(key.indisunique, true);
  assert.deepEqual((await sensorRows()).filter((r) => r.sensor_device_id === 'sensor_c').map((r) => r.id), [first]);
  assert.equal(await migrationRowCount('082_sensor_reading_key.sql'), 1);
  await pool.query(`DELETE FROM venue_sensor_data WHERE venue_place_id = 'ChIJbootsafety082'`);
});

// ---------------------------------------------------------------------------
// 9. 083 AND WHOSE REPLY IT IS.
// ---------------------------------------------------------------------------
//
// 083 records who wrote a venue's reply to a review, and gives each reply
// written before the column existed to the place's verified owner at the
// moment 083 first runs, unless the reply provably predates that owner's claim
// (older than their profile, or than the latest admin verification of it). It
// has to run ONCE: a replay must not hand a reply nobody could be given to
// whoever holds the place on the day of the replay, which is the exact
// misattribution the column exists to end.
//
// This section pins what 083 itself does, because that is what production
// ran. Some of its answers are wrong (the undated reply below among them) and
// 087 corrects them; section 10 is that correction.

const replyRows = async () => (await pool.query(
  `SELECT id, google_place_id, venue_reply, venue_replied_at, venue_reply_user_id
     FROM venue_reviews WHERE google_place_id LIKE 'ChIJbootsafety083%' ORDER BY id`
)).rows;

test('083 gives an old reply only to an owner who could have written it, and a replay moves nothing', async () => {
  // The database 083 meets: the reply text, and no column saying whose it is.
  await pool.query('ALTER TABLE venue_reviews DROP COLUMN IF EXISTS venue_reply_user_id');
  await pool.query(`DELETE FROM schema_migrations WHERE name = '083_venue_reply_author.sql'`);

  const reviewer = await insertUser('reviewer083@example.com', 'Reviewer 083');
  const owners = {};
  const profile = async (key, place, { verified = true, createdAgo = '30 days' } = {}) => {
    owners[key] = await insertUser(`${key}083@example.com`, `Owner ${key}`);
    return (await pool.query(
      `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified, created_at)
       VALUES ($1, $2, $3, $4, NOW() - $5::interval) RETURNING id`,
      [owners[key], `Room ${key}`, place, verified, createdAgo]
    )).rows[0].id;
  };
  const review = async (place, reply, repliedAgo, by = reviewer) => (await pool.query(
    `INSERT INTO venue_reviews (google_place_id, user_id, rating, text, venue_reply, venue_replied_at)
     VALUES ($1, $2, 4, 'Good night', $3, CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() - ($4::text)::interval END)
     RETURNING id`,
    [place, by, reply, repliedAgo]
  )).rows[0].id;

  // Written by the verified owner, after their claim: theirs.
  await profile('kept', 'ChIJbootsafety083a');
  const kept = await review('ChIJbootsafety083a', 'Thanks from the owner', '2 days');
  // The verified owner's profile is younger than the reply: somebody else wrote it.
  await profile('newcomer', 'ChIJbootsafety083b', { createdAgo: '1 day' });
  const beforeProfile = await review('ChIJbootsafety083b', 'Words from a previous owner', '5 days');
  // An older claim that an admin verified after the reply was written.
  const reverified = await profile('reverified', 'ChIJbootsafety083c');
  await pool.query(
    `INSERT INTO moderation_actions (moderator_id, target_user_id, action, content_type, content_id, created_at)
     VALUES (NULL, $1, 'venue_verified', 'venue_profile', $2, NOW() - INTERVAL '1 day')`,
    [owners.reverified, reverified]
  );
  const beforeVerification = await review('ChIJbootsafety083c', 'Words from before the verification', '5 days');
  // A retired reply (the review was edited after it): no timestamp to judge by.
  await profile('retired', 'ChIJbootsafety083d');
  const retired = await review('ChIJbootsafety083d', 'Retired words', null);
  // Nobody verified on the place: nobody can be given it.
  await profile('claimant', 'ChIJbootsafety083e', { verified: false });
  const unowned = await review('ChIJbootsafety083e', 'Words with no verified owner', '2 days');
  // No reply at all, from a second reviewer (one review per reviewer per place).
  const silent = await review('ChIJbootsafety083a', null, null, await insertUser('quiet083@example.com', 'Quiet 083'));

  await migrate(pool); // the deploy: must not throw

  const byId = Object.fromEntries((await replyRows()).map((r) => [r.id, r]));
  assert.equal(byId[kept].venue_reply_user_id, owners.kept, 'a reply the owner wrote after claiming was not given to them');
  assert.equal(byId[beforeProfile].venue_reply_user_id, null,
    'a reply older than the owner\'s profile was credited to an owner who cannot have written it');
  assert.equal(byId[beforeVerification].venue_reply_user_id, null,
    'a reply older than the owner\'s verification was credited to them');
  assert.equal(byId[retired].venue_reply_user_id, owners.retired, 'a retired reply stays with the verified owner to reuse');
  assert.equal(byId[unowned].venue_reply_user_id, null, 'a reply was credited on a place nobody holds');
  assert.equal(byId[silent].venue_reply_user_id, null);
  for (const r of Object.values(byId)) {
    if (r.id !== silent) assert.ok(r.venue_reply, 'no reply text was touched');
  }
  const { rows: [fk] } = await pool.query(
    `SELECT c.confdeltype FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'f' AND c.conrelid = 'venue_reviews'::regclass
       AND c.confrelid = 'users'::regclass AND a.attname = 'venue_reply_user_id'`
  );
  assert.equal(fk?.confdeltype, 'n', 'the author must be a foreign key to users that empties on deletion');

  // The replay, after the unowned place has found a verified owner. The
  // backfill must not run again and hand that owner words they never wrote.
  await pool.query(`UPDATE venue_profiles SET verified = true WHERE user_id = $1`, [owners.claimant]);
  const before = await replyRows();
  await pool.query(`DELETE FROM schema_migrations WHERE name = '083_venue_reply_author.sql'`);
  await migrate(pool);
  assert.deepEqual(await replyRows(), before, 'a second pass of 083 moved a row');
  assert.equal(await migrationRowCount('083_venue_reply_author.sql'), 1);

  // And @requires: a database that loses the column heals on the next boot.
  await pool.query('ALTER TABLE venue_reviews DROP COLUMN venue_reply_user_id');
  await migrate(pool);
  assert.ok(await columnExists('venue_reviews', 'venue_reply_user_id'), 'the column was not restored');
  assert.equal(await migrationRowCount('083_venue_reply_author.sql'), 1);

  await pool.query(`DELETE FROM venue_reviews WHERE google_place_id LIKE 'ChIJbootsafety083%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE '%083@example.com'`);
});

// ---------------------------------------------------------------------------
// 10. 087, AND THE REPLIES 083 GAVE OUT ON THE DAY IT RAN.
// ---------------------------------------------------------------------------
//
// 083 ran in production before its rule was corrected, and its guard means it
// never runs again, so 087 decides again what it wrote. This is that deploy on
// a populated table: 083 applied alone (087 held back by its recorded name,
// the way section 1 holds files back), replies written the reply route's way
// afterwards, then 087. It may decide again only the replies 083 could have
// written, and the replay at the end, which records 083 at the moment it runs
// and so makes every reply "older than 083", must move nothing.

const REPAIR_087 = '087_venue_reply_author_repair.sql';

const replyAuthorIndex = async () => (await pool.query(
  `SELECT c.oid, i.indisvalid, pg_get_indexdef(i.indexrelid) AS def
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_venue_reviews_reply_user'`
)).rows[0] || null;

const repairRows = async () => (await pool.query(
  `SELECT id, venue_reply, venue_replied_at, venue_reply_user_id
     FROM venue_reviews WHERE google_place_id LIKE 'ChIJbootsafety087%' ORDER BY id`
)).rows;

test('087 gives each reply 083 gave out to the owner who could have written it, once', async () => {
  // The table 083 met, with 087 recorded so the runner holds it back. The
  // index 087 builds goes with the column, so 087 is due again when released.
  await pool.query('ALTER TABLE venue_reviews DROP COLUMN IF EXISTS venue_reply_user_id');
  await pool.query(`DELETE FROM schema_migrations WHERE name = '083_venue_reply_author.sql'`);
  assert.equal(await migrationRowCount(REPAIR_087), 1, '087 must be recorded here, or it runs alongside 083');
  assert.equal(await replyAuthorIndex(), null);

  const owners = {};
  const profile = async (key, place, { verified = true } = {}) => {
    owners[key] = await insertUser(`${key}087@example.com`, `Owner ${key}`);
    return (await pool.query(
      `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified, created_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '90 days') RETURNING id`,
      [owners[key], `Room ${key}`, place, verified]
    )).rows[0].id;
  };
  // The row PUT /api/admin/venues/:profileId/verify writes with each decision.
  const audit = (userId, profileId, action, ago) => pool.query(
    `INSERT INTO moderation_actions (moderator_id, target_user_id, action, content_type, content_id, created_at)
     VALUES (NULL, $1, $2, 'venue_profile', $3, NOW() - $4::interval)`,
    [userId, action, profileId, ago]
  );
  // One review per reviewer per place, so every reply gets a reviewer of its own.
  let reviewers = 0;
  const review = async (place, reply, repliedAgo) => {
    reviewers += 1;
    const by = await insertUser(`r${reviewers}.reviewer087@example.com`, `Reviewer ${reviewers}`);
    return (await pool.query(
      `INSERT INTO venue_reviews (google_place_id, user_id, rating, text, venue_reply, venue_replied_at)
       VALUES ($1, $2, 4, 'Good night', $3, CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() - ($4::text)::interval END)
       RETURNING id`,
      [place, by, reply, repliedAgo]
    )).rows[0].id;
  };

  // Verified, then the claim moved off the place and back, which writes no
  // audit row, then verified again. The owner's own reply sits between.
  const moved = await profile('moved', 'ChIJbootsafety087a');
  await audit(owners.moved, moved, 'venue_verified', '20 days');
  await audit(owners.moved, moved, 'venue_verified', '5 days');
  const movedEarlier = await review('ChIJbootsafety087a', 'Thanks from before', '10 days');
  const movedLater = await review('ChIJbootsafety087a', 'Thanks from after', '2 days');

  // Verified, un-verified by an admin, verified again. The claim begins again
  // at the un-verify: the audit row cannot say which place the first
  // verification was for.
  const unverified = await profile('unverified', 'ChIJbootsafety087b');
  await audit(owners.unverified, unverified, 'venue_verified', '20 days');
  await audit(owners.unverified, unverified, 'venue_unverified', '8 days');
  await audit(owners.unverified, unverified, 'venue_verified', '5 days');
  const beforeUnverify = await review('ChIJbootsafety087b', 'Words from the first stretch', '10 days');

  // A retired reply on a review written before 083: no date to judge it by.
  const retired = await profile('retired', 'ChIJbootsafety087c');
  await audit(owners.retired, retired, 'venue_verified', '20 days');
  const undated = await review('ChIJbootsafety087c', 'Undated words', null);

  // Verified before migration 020 wrote audit rows: no venue_verified row.
  await profile('legacy', 'ChIJbootsafety087d');
  const legacyReply = await review('ChIJbootsafety087d', 'Words on a legacy claim', '2 days');

  // The owner's claim left the place, a rival held it, and the owner came back
  // and was verified again. The rival's claim is still on the place.
  const current = await profile('current', 'ChIJbootsafety087e');
  const rival = await profile('rival', 'ChIJbootsafety087e', { verified: false });
  await audit(owners.current, current, 'venue_verified', '20 days');
  await audit(owners.rival, rival, 'venue_verified', '12 days');
  await audit(owners.rival, rival, 'venue_unverified', '6 days');
  await audit(owners.current, current, 'venue_verified', '3 days');
  const beforeRival = await review('ChIJbootsafety087e', "The owner's, before it left", '15 days');
  const rivalWords = await review('ChIJbootsafety087e', "The rival's, while it held the place", '8 days');
  const afterReturn = await review('ChIJbootsafety087e', "The owner's, after it came back", '1 day');

  // A deleted venue account's audit rows outlive its profile (deleteAccount
  // de-attributes them), so nothing says which place they were for.
  const survivor = await profile('survivor', 'ChIJbootsafety087f');
  await audit(owners.survivor, survivor, 'venue_verified', '70 days');
  await audit(owners.survivor, survivor, 'venue_verified', '3 days');
  const gone = Number((await pool.query('SELECT COALESCE(MAX(id), 0) + 100000 AS id FROM venue_profiles')).rows[0].id);
  await audit(null, gone, 'venue_verified', '60 days');
  await audit(null, gone, 'venue_unverified', '55 days');
  const whileGoneHeld = await review('ChIJbootsafety087f', 'Written while the deleted account was verified', '58 days');
  const afterGone = await review('ChIJbootsafety087f', 'Written after it no longer was', '50 days');

  // Nobody verified on the place.
  await profile('claimant', 'ChIJbootsafety087g', { verified: false });
  const unowned = await review('ChIJbootsafety087g', 'Words with no verified owner', '2 days');

  await migrate(pool); // 083, as production ran it

  const authors = async () => Object.fromEntries((await repairRows()).map((r) => [r.id, r.venue_reply_user_id]));
  let by = await authors();
  // 083's answers, which are what 087 meets.
  assert.equal(by[movedEarlier], null);
  assert.equal(by[movedLater], owners.moved);
  assert.equal(by[beforeUnverify], null);
  assert.equal(by[undated], owners.retired);
  assert.equal(by[legacyReply], owners.legacy);
  assert.equal(by[beforeRival], null);
  assert.equal(by[rivalWords], null);
  assert.equal(by[afterReturn], owners.current);
  assert.equal(by[whileGoneHeld], null);
  assert.equal(by[afterGone], null);
  assert.equal(by[unowned], null);

  // After 083 the reply route writes the author with the words: a reply dated
  // after 083, and a retired one on a review written after 083.
  const route = await profile('route', 'ChIJbootsafety087h');
  await audit(owners.route, route, 'venue_verified', '30 days');
  const routeReply = await review('ChIJbootsafety087h', null, null);
  const retiredLater = await review('ChIJbootsafety087h', null, null);
  for (const id of [routeReply, retiredLater]) {
    await pool.query(
      `UPDATE venue_reviews SET venue_reply = 'From the route', venue_replied_at = NOW(), venue_reply_user_id = $2
        WHERE id = $1`,
      [id, owners.route]
    );
  }
  await pool.query('UPDATE venue_reviews SET text = $2, venue_replied_at = NULL WHERE id = $1', [retiredLater, 'Rewritten']);
  // Then the place changes hands, so the rule, asked now, would take both
  // replies from the account that wrote them.
  const next = await profile('next', 'ChIJbootsafety087h', { verified: false });
  await pool.query('UPDATE venue_profiles SET verified = false WHERE id = $1', [route]);
  await audit(owners.route, route, 'venue_unverified', '0 seconds');
  await pool.query('UPDATE venue_profiles SET verified = true WHERE id = $1', [next]);
  await audit(owners.next, next, 'venue_verified', '0 seconds');

  const before087 = await repairRows();
  await pool.query('DELETE FROM schema_migrations WHERE name = $1', [REPAIR_087]);
  await migrate(pool); // the deploy that carries 087

  by = await authors();
  assert.equal(by[movedEarlier], owners.moved, "an owner's own reply from before a later verification has no author");
  assert.equal(by[movedLater], owners.moved);
  assert.equal(by[beforeUnverify], null, 'a reply from before an admin un-verified the claim was given to it');
  assert.equal(by[undated], null, 'an undated reply stayed with whoever held the place when 083 ran');
  assert.equal(by[legacyReply], null, 'a claim with no venue_verified row kept a reply on the date of its profile');
  assert.equal(by[beforeRival], owners.current);
  assert.equal(by[rivalWords], null, "a rival's reply, from while the rival was verified, was given to the owner");
  assert.equal(by[afterReturn], owners.current);
  assert.equal(by[whileGoneHeld], null, 'a reply from while a deleted account held a verification was given to the owner');
  assert.equal(by[afterGone], owners.survivor);
  assert.equal(by[unowned], null);
  assert.equal(by[routeReply], owners.route, '087 decided again a reply the route wrote after 083');
  assert.equal(by[retiredLater], owners.route, '087 decided again a retired reply on a review written after 083');

  // The author moved and nothing else did.
  const after087 = await repairRows();
  const wordsAndDates = (rows) => rows.map(({ id, venue_reply, venue_replied_at }) => ({ id, venue_reply, venue_replied_at }));
  assert.deepEqual(wordsAndDates(after087), wordsAndDates(before087), "087 touched a reply's words or its date");

  const index = await replyAuthorIndex();
  assert.ok(index, '087 did not build its index');
  assert.equal(index.indisvalid, true);
  assert.match(index.def, /\(venue_reply_user_id\) WHERE \(venue_reply_user_id IS NOT NULL\)$/);

  // THE REPLAY: 083 and 087 again over this data, with their rows gone from
  // schema_migrations, so 083 is recorded now and every reply above is "older
  // than 083". Place h is held by `next`, so a second pass of 087 would empty
  // both route replies. (Section 3 replays the whole chain, over a venue audit
  // row as well since 017's narrower CHECK went NOT VALID; this one replays
  // only 083 and 087, so it can count exactly what those two move.)
  await pool.query('DELETE FROM schema_migrations WHERE name = ANY($1)', [['083_venue_reply_author.sql', REPAIR_087]]);
  await migrate(pool);
  assert.deepEqual(await repairRows(), after087, 'a replay of 087 moved a row');
  assert.equal((await replyAuthorIndex()).oid, index.oid, 'a replay rebuilt the index');
  assert.equal(await migrationRowCount('083_venue_reply_author.sql'), 1);
  assert.equal(await migrationRowCount(REPAIR_087), 1);

  // The control, so the replay above is not passing on nothing: the index is
  // what holds it. Without the index the same replay decides the route's
  // replies again, against today's owner, and empties them.
  await pool.query('DROP INDEX idx_venue_reviews_reply_user');
  await pool.query('DELETE FROM schema_migrations WHERE name = ANY($1)', [['083_venue_reply_author.sql', REPAIR_087]]);
  await migrate(pool);
  by = await authors();
  assert.equal(by[routeReply], null, 'the control did not reach the route reply, so the replay proved nothing');
  assert.equal(by[retiredLater], null);
  assert.ok(await replyAuthorIndex(), 'the control run rebuilds the index');

  await pool.query(`DELETE FROM venue_reviews WHERE google_place_id LIKE 'ChIJbootsafety087%'`);
  await pool.query('DELETE FROM moderation_actions WHERE content_id = $1', [gone]);
  await pool.query(`DELETE FROM users WHERE email LIKE '%087@example.com'`);
});

// ---------------------------------------------------------------------------
// 11. 088, AND THE SHARES A GHOST COMMIT COULD HAVE WRITTEN.
// ---------------------------------------------------------------------------
//
// 088 adds bill_split_shares.posted and backfills it true only where the row's
// member never committed on that bill, the one proof the rows hold that no
// figure on them came from a ghost commit (the first versions of which copied
// the raw budget minimum into any bill). This is the deploy on a populated
// table: the column gone, the shares as they stood, then the chain. The replay
// records 088 again and must move nothing, including rows written after 088
// by the rules that set the column directly, and a database that has lost the
// column heals on the next boot.

const SHARE_POSTED_088 = '088_bill_share_posted.sql';

test('088 posts only the shares nobody committed on, once, and a lost column heals', async () => {
  await pool.query('ALTER TABLE bill_split_shares DROP COLUMN IF EXISTS posted');
  await pool.query('DELETE FROM schema_migrations WHERE name = $1', [SHARE_POSTED_088]);

  const payer = await insertUser('payer088@example.com', 'Payer 088');
  const plain = await insertUser('plain088@example.com', 'Plain 088');
  const committer = await insertUser('committer088@example.com', 'Committer 088');
  const flock = async (name) => (await pool.query(
    'INSERT INTO flocks (name, creator_id) VALUES ($1, $2) RETURNING id', [name, payer]
  )).rows[0].id;
  const bill = async (flockId, paidBy) => (await pool.query(
    "INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent) VALUES ($1, 90, 'equal', $2, 0) RETURNING id",
    [flockId, paidBy]
  )).rows[0].id;
  // A posted bill: the payer's row and a plain member's, nobody committed;
  // a member who committed first; and the first ghost commit's row, which is
  // committed too and carries the raw minimum.
  const posted = await bill(await flock('Posted 088'), payer);
  // A shell: every row a commitment.
  const shell = await bill(await flock('Shell 088'), null);
  await pool.query(
    `INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled, paid_amount) VALUES
       ($1, $3, 30, false, true, 0), ($1, $4, 30, false, false, 0), ($1, $5, 47.13, true, false, 0),
       ($2, $4, 40, true, false, 0), ($2, $5, 40, true, true, 0)`,
    [posted, shell, payer, plain, committer]
  );
  const rows = async () => (await pool.query(
    'SELECT bill_id, user_id, committed, posted FROM bill_split_shares WHERE bill_id = ANY($1::int[]) ORDER BY bill_id, user_id',
    [[posted, shell]]
  )).rows;

  await migrate(pool); // the deploy: must not throw

  const after = await rows();
  assert.equal(after.length, 5);
  for (const r of after) {
    assert.equal(r.posted, r.committed !== true, `bill ${r.bill_id} user ${r.user_id}: posted is exactly "never committed"`);
  }
  const { rows: [col] } = await pool.query(
    `SELECT attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'bill_split_shares'::regclass AND a.attname = 'posted'`
  );
  assert.deepEqual([col.attnotnull, col.def], [true, 'false'], 'a row nothing marks must read as not posted');

  // After 088 the routes set the column themselves: POST /create writes a
  // committed member's fresh row as posted, and a ghost commit writes one that
  // is not. The replay, which records 088 at the moment it runs, must leave
  // both, and everything above, exactly as they are.
  const later = await bill(await flock('Later 088'), payer);
  await pool.query(
    `INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled, paid_amount, posted) VALUES
       ($1, $2, 30, true, false, 0, true), ($1, $3, 30, true, false, 0, false)`,
    [later, committer, plain]
  );
  const everyRow = async () => (await pool.query(
    'SELECT id, posted FROM bill_split_shares WHERE bill_id = ANY($1::int[]) ORDER BY id', [[posted, shell, later]]
  )).rows;
  const before = await everyRow();
  await pool.query('DELETE FROM schema_migrations WHERE name = $1', [SHARE_POSTED_088]);
  await migrate(pool);
  assert.deepEqual(await everyRow(), before, 'a second pass of 088 moved a row');
  assert.equal(await migrationRowCount(SHARE_POSTED_088), 1);

  // And @requires: a database that loses the column heals on the next boot,
  // back on the side that shows nothing unproven.
  await pool.query('ALTER TABLE bill_split_shares DROP COLUMN posted');
  await migrate(pool);
  assert.ok(await columnExists('bill_split_shares', 'posted'), 'the column was not restored');
  assert.equal(await migrationRowCount(SHARE_POSTED_088), 1);
  for (const r of await rows()) assert.equal(r.posted, r.committed !== true);

  await pool.query(`DELETE FROM users WHERE email LIKE '%088@example.com'`);
});

test('every migration file declares post-conditions the runner can actually parse', async () => {
  // parseRequirements throws on a line that looks like a declaration and is
  // not: mis-cased, schema-mangled, malformed, or buried in a $$ body, a block
  // comment or a string literal where the old regex still matched it. That
  // throw is a fatal boot by design, because a requirement the runner cannot
  // evaluate must never be read as evidence a migration is missing. This is
  // where it is supposed to be caught.
  const { parseRequirements, requirementKey, parseDrops } = require('../db/migrate');
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const declared = new Map();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    let reqs;
    assert.doesNotThrow(() => { reqs = parseRequirements(sql, f); }, `${f} has an unusable @requires line`);
    for (const r of reqs) declared.set(requirementKey(r), f);
  }
  assert.ok(declared.size >= 11, 'the four files that declare post-conditions must still be parsed, not skipped');

  // A later file that drops something an earlier one requires does not fight
  // it and does not resurrect it; the requirement is retired. Nothing in the
  // directory does that today, and this is the check that says so out loud
  // rather than leaving it to be discovered by a silent re-add.
  for (const f of files) {
    const drops = parseDrops(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    for (const d of drops) {
      const owner = declared.get(d);
      if (owner && owner < f) {
        assert.fail(`${f} drops ${d}, which ${owner} still declares with @requires. Delete that line in this change.`);
      }
    }
  }
});

test('a requirement is checked against a catalog no role can hide', async () => {
  const { findMissingRequirements, parseRequirements } = require('../db/migrate');
  const client = await pool.connect();
  try {
    // Case folding: Postgres stores an unquoted identifier lower-cased, and the
    // old parser compared `Served_Predictions` to `served_predictions` and
    // failed forever.
    assert.deepEqual(
      await findMissingRequirements(client, parseRequirements('-- @requires table Served_Predictions\n')), []
    );
    // Schema qualification used to parse as a bare table named `public`.
    assert.deepEqual(
      await findMissingRequirements(client, parseRequirements(
        '-- @requires table public.served_predictions\n-- @requires column public.venue_feedback.served_prediction_id\n'
      )), []
    );
    // A view was invisible to the old relkind filter, so a file that created
    // one could never satisfy its own post-condition.
    await client.query('CREATE OR REPLACE VIEW bootsafety_probe_view AS SELECT 1 AS one');
    assert.deepEqual(
      await findMissingRequirements(client, parseRequirements(
        '-- @requires table bootsafety_probe_view\n-- @requires column bootsafety_probe_view.one\n'
      )), []
    );
    // And something genuinely absent is still reported, in printable form.
    assert.deepEqual(
      await findMissingRequirements(client, parseRequirements(
        '-- @requires table bootsafety_no_such_table\n-- @requires column venue_feedback.bootsafety_no_such_column\n'
      )),
      ['column venue_feedback.bootsafety_no_such_column', 'table bootsafety_no_such_table']
    );
  } finally {
    await client.query('DROP VIEW IF EXISTS bootsafety_probe_view').catch(() => {});
    client.release();
  }
});

test('a role with no grants on a table does not read its columns as missing', async () => {
  // information_schema.columns is privilege-filtered and pg_attribute is not.
  // Reading the first one meant that under any role that is not the table's
  // owner, a perfectly healthy database reported three missing columns on
  // venue_feedback, the heal deleted 032's row on that evidence, and the
  // re-apply threw 42501 on every boot. Railway runs migrations as superuser
  // today, so this is the trap set for the day it does not.
  await pool.query('DROP ROLE IF EXISTS bootsafety_hardened');
  await pool.query("CREATE ROLE bootsafety_hardened LOGIN PASSWORD 'bootsafety'");
  await pool.query('GRANT USAGE ON SCHEMA public TO bootsafety_hardened');
  await pool.query('REVOKE ALL ON venue_feedback FROM bootsafety_hardened');

  const hardened = new Pool({
    connectionString:
      `postgresql://bootsafety_hardened:bootsafety@127.0.0.1:${PG_PORT}/flock_bootsafety_test`,
  });
  try {
    const { findMissingRequirements, parseRequirements } = require('../db/migrate');
    const client = await hardened.connect();
    try {
      const reqs = parseRequirements(fs.readFileSync(
        path.join(MIGRATIONS_DIR, '032_served_predictions.sql'), 'utf8'
      ), '032_served_predictions.sql');
      assert.deepEqual(
        await findMissingRequirements(client, reqs), [],
        'a role that cannot SELECT the table can still see that its columns exist'
      );
    } finally {
      client.release();
    }
  } finally {
    await hardened.end().catch(() => {});
    await pool.query('DROP ROLE IF EXISTS bootsafety_hardened').catch(() => {});
  }
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
