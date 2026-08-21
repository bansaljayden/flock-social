'use strict';
// ---------------------------------------------------------------------------
// THE MIGRATION VERIFIER HAS TO RESOLVE A NAME THE WAY THE MIGRATION DOES.
// ---------------------------------------------------------------------------
//
// `-- @requires table x` / `-- @requires column t.c` are post-conditions that
// db/migrate.js checks after a file runs and before it records the row. The
// check used to look the name up with
//
//     n.nspname = COALESCE(w.sch, current_schema())
//
// and current_schema() is not where Postgres FINDS an existing relation. It is
// only the first entry of search_path, which is where a new unqualified object
// is CREATED. An existing one is found by walking every entry. So a database
// whose search_path has more than one schema could have the verifier disagree
// with the identical unqualified DDL the migration itself just ran, and with
// every query the application makes.
//
// The shape that does it: `search_path = migrations, public`, the ledger in
// `migrations.schema_migrations`, the Flock tables in `public`. The app reads
// public.venue_feedback fine; the verifier reported its columns missing. That
// is not a warning. assertRequirementsMet throws, the file rolls back,
// migrate() rejects, and server.js exits 1 before it ever calls listen(), on
// every boot, over a schema that was correct the whole time. The heal reads the
// same evidence and re-applies every already-applied file each boot before
// declaring the service degraded.
//
// It is a server behaviour, so only a server can answer it: everything below
// runs against a real embedded Postgres with a real multi-entry search_path.
// The four cases are the whole contract:
//
//   1. an unqualified requirement is satisfied by the relation the search path
//      actually resolves to, even when that is not current_schema();
//   2. it is NOT satisfied by a relation the search path does not resolve to,
//      which is what keeps this "resolve the name" rather than "look
//      everywhere" (a shadowing table earlier in the path wins, exactly as it
//      wins for the ALTER);
//   3. a schema-qualified requirement still means precisely the schema it
//      names, which is what to write when a name is ambiguous across the path;
//   4. a genuinely absent table is still reported, so none of the above bought
//      its correctness with a false green.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Client } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

const { findMissingRequirements } = require('../db/migrate');

const PG_PORT = pickEmbeddedPgPort('migrationSearchPath');

let pg;
let client;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-searchpath-pg-'));
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'migrationSearchPath', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  client = new Client({
    host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'postgres',
  });
  await client.connect();

  // The reviewer's database, built exactly. `migrations` holds the ledger and
  // is first in the path, so it is current_schema(); the application's tables
  // are in `public`, which is second.
  await client.query('CREATE SCHEMA migrations');
  await client.query('SET search_path = migrations, public');
  await client.query(`CREATE TABLE migrations.schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
  await client.query('CREATE TABLE public.venue_feedback (id serial primary key, crowd_level int)');
});

test.after(async () => {
  if (client) await client.end().catch(() => {});
  if (pg) await pg.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the premise: current_schema() is not where an unqualified name resolves', async () => {
  const { rows } = await client.query(
    "SELECT current_schema() AS cur, to_regclass('venue_feedback')::text AS resolved");
  assert.equal(rows[0].cur, 'migrations',
    'the ledger schema is first in the path, so it is current_schema()');
  assert.equal(rows[0].resolved, 'venue_feedback',
    'and the unqualified name still resolves, to the table in public');
  const { rows: nsp } = await client.query(
    "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('venue_feedback')");
  assert.equal(nsp[0].nspname, 'public',
    'if these two ever agree the rest of this file is testing nothing');
});

test('an unqualified requirement is met by the table the search path resolves to', async () => {
  // The unqualified DDL a migration runs, against the same connection, first.
  // Whatever this reaches is what the requirement has to be checked against;
  // anything else is the verifier and the migration disagreeing about one name.
  await client.query('ALTER TABLE venue_feedback ADD COLUMN IF NOT EXISTS served_prediction_id INTEGER');

  const missing = await findMissingRequirements(client, [
    { kind: 'table', schema: null, table: 'venue_feedback' },
    { kind: 'column', schema: null, table: 'venue_feedback', column: 'served_prediction_id' },
  ]);
  assert.deepEqual(missing, [],
    'the column is on the table the ALTER reached and the application reads, so it is not missing');
});

test('a relation the search path does NOT resolve to cannot satisfy an unqualified requirement', async () => {
  // Same name, earlier schema, without the column. Postgres resolves the
  // unqualified name to THIS one now, and so must the check: a requirement is
  // about the relation the app will actually use, not about whether the name
  // exists somewhere in the database.
  await client.query('CREATE TABLE migrations.venue_feedback (id serial primary key)');
  try {
    const { rows } = await client.query(
      "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('venue_feedback')");
    assert.equal(rows[0].nspname, 'migrations', 'the shadow now wins the lookup');

    const missing = await findMissingRequirements(client, [
      { kind: 'column', schema: null, table: 'venue_feedback', column: 'served_prediction_id' },
    ]);
    assert.deepEqual(missing, ['column venue_feedback.served_prediction_id'],
      'the visible table has no such column, and a copy in another schema does not make it present');
  } finally {
    await client.query('DROP TABLE migrations.venue_feedback');
  }
});

test('a schema-qualified requirement means that schema and no other', async () => {
  // Both directions. Qualification is the answer when a name is ambiguous
  // across the path, so it has to keep meaning exactly what it says even while
  // a shadow is winning the unqualified lookup.
  await client.query('CREATE TABLE migrations.venue_feedback (id serial primary key)');
  try {
    const met = await findMissingRequirements(client, [
      { kind: 'table', schema: 'public', table: 'venue_feedback' },
      { kind: 'column', schema: 'public', table: 'venue_feedback', column: 'served_prediction_id' },
    ]);
    assert.deepEqual(met, [], 'public.venue_feedback has the column, whatever is shadowing the bare name');

    const unmet = await findMissingRequirements(client, [
      { kind: 'column', schema: 'migrations', table: 'venue_feedback', column: 'served_prediction_id' },
    ]);
    assert.deepEqual(unmet, ['column migrations.venue_feedback.served_prediction_id'],
      'the shadow really does lack it, and naming a schema must not fall back to searching the path');
  } finally {
    await client.query('DROP TABLE migrations.venue_feedback');
  }
});

test('something that is genuinely absent is still reported missing', async () => {
  const missing = await findMissingRequirements(client, [
    { kind: 'table', schema: null, table: 'no_such_table' },
    { kind: 'column', schema: null, table: 'venue_feedback', column: 'no_such_column' },
    { kind: 'table', schema: 'no_such_schema', table: 'venue_feedback' },
  ]);
  assert.deepEqual(missing.sort(), [
    'column venue_feedback.no_such_column',
    'table no_such_schema.venue_feedback',
    'table no_such_table',
  ]);
});

test('a schema that is not on the search path at all cannot satisfy an unqualified requirement', async () => {
  // The failure the check must never trade for the fix above: matching on
  // relname alone would pass this, and would then report a migration as
  // satisfied by a table nothing in the application can see.
  await client.query('CREATE SCHEMA IF NOT EXISTS attic');
  await client.query('CREATE TABLE IF NOT EXISTS attic.forgotten_table (id serial primary key, ghost int)');
  const missing = await findMissingRequirements(client, [
    { kind: 'table', schema: null, table: 'forgotten_table' },
    { kind: 'column', schema: null, table: 'forgotten_table', column: 'ghost' },
  ]);
  assert.deepEqual(missing.sort(), [
    'column forgotten_table.ghost',
    'table forgotten_table',
  ]);
});
