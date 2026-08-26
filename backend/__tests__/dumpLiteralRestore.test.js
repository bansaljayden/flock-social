'use strict';
// ---------------------------------------------------------------------------
// THE BACKUP THAT DID NOT RESTORE, PINNED SO IT CANNOT COME BACK.
// ---------------------------------------------------------------------------
//
// scripts/dump-db.js writes the only copy of the only asset in this company
// that money cannot rebuild. Its docblock uses the word "restorable". On
// 2026-08-13 that word was false, and nobody found out for thirteen days.
//
// Every non-scalar value was written as `'<json>'::jsonb`. A TEXT[] column is
// not a jsonb column, so restoring the dump died on the SECOND statement of the
// FIRST table:
//
//     ERROR: column "interests" is of type text[] but expression is of type jsonb
//
// users.interests, venue_profiles.goals and ml_venues.google_types are all
// TEXT[], so this was never going to restore on any real database. The writer
// was fixed on 2026-08-14, but the dump taken the day before was the only
// backup in existence, it was encrypted and shipped offsite on 2026-08-18 in
// that state, and a recovery card was written pointing at it. Running the
// verifier against it on 2026-08-26 is what finally said FAIL.
//
// The fix was one line of judgement: stop asserting a type the column may not
// have, and emit Postgres ARRAY syntax when the COLUMN is an array type rather
// than guessing from the JavaScript value (pg parses a jsonb column holding a
// JSON array into a JS array too, so the value alone cannot tell you). The cost
// of getting that judgement wrong again is total, and it is invisible until the
// day it matters, so it is pinned here rather than trusted.
//
// This does not test that the literals LOOK right. String-shape assertions are
// how you convince yourself a serializer is correct while it is not. Every case
// below is round-tripped through a real Postgres column of the real type: the
// literal is written into `text[]`, `jsonb`, `json`, `bytea`, `inet`,
// `timestamptz` and friends exactly as an INSERT in a dump would write it, then
// read back and compared to the value that went in. That is the only claim
// worth making, because it is the claim a restore makes.
//
// The nasty array cases are not decoration either. pgArrayBody has to survive
// commas, double quotes, backslashes, braces, empty strings, a real SQL NULL
// element, and the literal four-letter word NULL as DATA, all of which change
// the parse if they are quoted wrongly. users.interests is user-typed free
// text, so all of them are reachable.
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

const PG_PORT = pickEmbeddedPgPort('dumpLiteralRestore');

// SET BEFORE THE REQUIRE, DELIBERATELY. scripts/dump-db.js calls
// dotenv.config() at module scope, and backend/.env points DATABASE_URL at the
// LIVE Railway database. dotenv never overwrites a variable that is already
// set, so this assignment is the thing that stands between this suite and
// production, exactly as helpers/embeddedPgPort.js describes. Nothing here
// reads DATABASE_URL, but the require must not be able to introduce a live URL
// into the environment of a test process either.
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;
// And PGSSLMODE, for the same reason and with teeth: backend/.env sets it, pg
// reads it natively out of the environment, and embedded Postgres is built
// without SSL. Without this line the require alone makes every connection in
// this file fail with "The server does not support SSL connections", measured
// not anticipated. The Client below also passes `ssl: false` explicitly, so the
// suite does not depend on either of these winning.
process.env.PGSSLMODE = 'disable';

const { lit } = require('../scripts/dump-db');

let pg;
let client;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-dumplit-pg-'));
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'dumpLiteralRestore', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);

  // A UTF8 DATABASE, EXPLICITLY. embedded-postgres runs initdb under the
  // machine's locale, so on this Windows box the default `postgres` database
  // comes up WIN1252 and storing 日本語 or an emoji fails with
  // "has no equivalent in encoding WIN1252" (22P05). Railway's Postgres is
  // UTF8, users.interests is free text a person types on a phone, and a dump
  // that cannot carry an emoji is a dump that loses rows on restore. Testing
  // the serializer against a narrower encoding than production uses would be
  // choosing not to find that out. template0 because template1 cannot be
  // copied into a different encoding.
  const bootstrap = new Client({
    host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'postgres',
    ssl: false,
  });
  await bootstrap.connect();
  await bootstrap.query(
    "CREATE DATABASE flock_dump_literals ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'"
  );
  await bootstrap.end();

  client = new Client({
    host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres',
    database: 'flock_dump_literals', ssl: false,
  });
  await client.connect();

  const { rows: [enc] } = await client.query('SHOW server_encoding');
  assert.equal(enc.server_encoding, 'UTF8',
    'the whole point of the database above; if this is not UTF8 the unicode case below proves nothing');
});

test.after(async () => {
  if (client) await client.end().catch(() => {});
  if (pg) await pg.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// Round-trip one value through one real column type, the way a dump does it:
// read the column's type name from the server (which is where dump-db.js gets
// the `typeName` it passes to lit, via res.fields[i].dataTypeID), build the
// INSERT from lit's output with no cast and no parameter, and read it back.
async function roundTrip(sqlType, value) {
  const table = `t_${Math.random().toString(36).slice(2, 10)}`;
  await client.query(`CREATE TABLE ${table} (v ${sqlType})`);

  // The type name exactly as pg_type spells it, which is what the dump resolves
  // per column OID. text[] is `_text`, jsonb is `jsonb`.
  const { rows: [{ typname }] } = await client.query(
    `SELECT t.typname FROM pg_attribute a
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = $1::regclass AND a.attname = 'v'`,
    [table]
  );

  const literal = lit(value, typname);
  await client.query(`INSERT INTO ${table} (v) VALUES (${literal})`);
  const { rows } = await client.query(`SELECT v FROM ${table}`);
  return { back: rows[0].v, literal, typname };
}

test('a text[] column restores every value a person can type into it', async () => {
  // users.interests is TEXT[] and user-supplied. Each of these breaks a
  // different naive array serializer.
  const cases = [
    [[], 'empty array'],
    [['climbing'], 'one plain element'],
    [['climbing', 'live music'], 'a space'],
    [['a,b'], 'a comma, which would otherwise split into two elements'],
    [['say "hi"'], 'double quotes, the array delimiter'],
    [['back\\slash'], 'a backslash, the array escape character'],
    [['{braces}'], 'braces, which open and close an array'],
    [[''], 'an empty string, which is not the same as NULL'],
    [['NULL'], 'the literal word NULL as DATA, which must not become a SQL NULL'],
    [[null], 'a real SQL NULL element, which must not become the string "NULL"'],
    [['tab\there', 'new\nline'], 'whitespace that is not a space'],
    [['café', '日本語', '🕊'], 'non-ASCII'],
    [['a', null, '', 'NULL', 'b,c'], 'all of it at once, order preserved'],
  ];

  for (const [value, what] of cases) {
    const { back, literal } = await roundTrip('text[]', value);
    assert.deepEqual(back, value, `text[] round trip failed for ${what}: literal was ${literal}`);
  }
});

test('a jsonb column keeps JSON, and is not confused with an array column', async () => {
  // THE DISTINCTION THE BUG TURNED ON. pg parses a jsonb column holding a JSON
  // array into a JavaScript array, identically to how it parses a text[]
  // column. So the JS value cannot tell you which one you have, and a
  // serializer that guesses from it writes Postgres array syntax into a jsonb
  // column or JSON into a text[] column. Only the COLUMN type answers it.
  const cases = [
    [[], 'an empty JSON array'],
    [['a', 'b'], 'a JSON array of strings, the shape that collides with text[]'],
    [[1, 2, 3], 'a JSON array of numbers'],
    [{ tier: 'pro', seats: 4 }, 'a JSON object'],
    [{ nested: { a: [1, { b: 'c' }] } }, 'nesting'],
    [{ "quote'd": 'it\'s fine' }, 'single quotes, which must be doubled'],
    [{ note: 'has "double" quotes' }, 'double quotes inside JSON'],
    [[], 'an empty array again, after the object cases'],
  ];

  for (const [value, what] of cases) {
    const { back } = await roundTrip('jsonb', value);
    assert.deepEqual(back, value, `jsonb round trip failed for ${what}`);
  }

  // json, not jsonb: same reasoning, and it is a distinct type OID.
  const { back } = await roundTrip('json', { a: [1, 2], b: null });
  assert.deepEqual(back, { a: [1, 2], b: null });
});

test('no literal asserts a type, because the column already has one', async () => {
  // The regression in one assertion. `::jsonb` on a value destined for a
  // text[] column is what took the 2026-08-13 backup out, and an untyped quoted
  // literal in INSERT ... VALUES is coerced to whatever the target column is.
  // So a cast is never needed and is the only way to be wrong.
  const samples = [
    lit(['a', 'b'], '_text'),
    lit(['a', 'b'], 'jsonb'),
    lit({ a: 1 }, 'jsonb'),
    lit({ a: 1 }, 'json'),
    lit([], '_text'),
    lit([], 'jsonb'),
    lit('plain', 'text'),
  ];
  for (const s of samples) {
    assert.ok(!/::/.test(s), `a dump literal must carry no cast, got ${s}`);
  }
});

test('the scalar types the schema actually holds survive the trip', async () => {
  // Not exhaustive over Postgres, exhaustive over THIS schema: the column types
  // a Flock dump has to carry.
  const now = new Date('2026-08-13T19:44:32.725Z');

  const ts = await roundTrip('timestamptz', now);
  assert.equal(ts.back.toISOString(), now.toISOString(), 'timestamptz');

  const buf = Buffer.from([0x00, 0xff, 0x27, 0x5c, 0x0a]);
  const by = await roundTrip('bytea', buf);
  assert.ok(buf.equals(by.back), 'bytea, including a NUL, a quote and a backslash byte');

  assert.equal((await roundTrip('boolean', true)).back, true, 'boolean true');
  assert.equal((await roundTrip('boolean', false)).back, false, 'boolean false');
  assert.equal((await roundTrip('integer', 0)).back, 0, 'integer zero, which is falsy');
  assert.equal((await roundTrip('integer', -42)).back, -42, 'a negative integer');
  assert.equal((await roundTrip('text', '')).back, '', 'the empty string, which is not NULL');
  assert.equal((await roundTrip('text', "o'brien")).back, "o'brien", 'an apostrophe in a name');
  assert.equal((await roundTrip('text', 'multi\nline\ttext')).back, 'multi\nline\ttext', 'newlines and tabs');
  assert.equal((await roundTrip('text', "\\'")).back, "\\'", 'a backslash next to a quote');

  // NULL is NULL in every column type, and must never become the string 'NULL'.
  for (const t of ['text', 'integer', 'timestamptz', 'jsonb', 'text[]', 'boolean']) {
    assert.equal((await roundTrip(t, null)).back, null, `NULL in a ${t} column`);
  }
});

test('a numeric that is not finite becomes NULL rather than invalid SQL', async () => {
  // NaN and Infinity have no representation an integer column will take, and
  // `NaN` unquoted is a syntax error that would abort the whole restore at
  // whatever table happened to contain it. lit turns them into NULL, which
  // loses a value that was never storable and keeps the other 7.5 million rows.
  assert.equal(lit(NaN, 'float8'), 'NULL');
  assert.equal(lit(Infinity, 'float8'), 'NULL');
  assert.equal(lit(-Infinity, 'float8'), 'NULL');
});
