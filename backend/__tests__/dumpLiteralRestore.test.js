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
// below is round-tripped through a real Postgres column of the real type,
// exactly as an INSERT in a dump would write it, then read back and compared to
// the value that went in. That is the only claim worth making, because it is
// the claim a restore makes.
//
// AND THE LIST OF TYPES IS BUILT, NOT REMEMBERED. The 2026-08-26 version of
// this file listed the types it covered in this paragraph, named `inet` among
// them (this schema has no inet column, and nothing here touched one), and did
// not cover `timestamp without time zone` at all, of which the schema has
// twenty, including flocks.event_time. Every one of them was moving by the
// dumping machine's UTC offset on restore. The last test in the file now builds
// the schema from the migration chain and fails on any column type nothing here
// round-trips, so the paragraph cannot go stale again.
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

const { lit, DUMP_TYPES } = require('../scripts/dump-db');

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
  // DUMP_TYPES, because that is what scripts/dump-db.js reads a row with. A
  // helper that used the default parsers would be measuring a dump nobody
  // takes, which is how the naive-timestamp shift below survived the first
  // version of this file.
  const { rows } = await client.query({ text: `SELECT v FROM ${table}`, types: DUMP_TYPES });
  return { back: rows[0].v, literal, typname };
}

// ---------------------------------------------------------------------------
// THE FULL LOOP, THE WAY AN OPERATOR RUNS IT.
// ---------------------------------------------------------------------------
// roundTrip above starts from a JavaScript value, which is the right shape for
// asking "does lit write this correctly". It cannot ask the question that
// actually decides whether the backup restores, which is: does the row that
// comes OUT of the restored database equal the row that was IN the live one?
//
// Those differ whenever the driver's read is itself lossy. `timestamp without
// time zone` is exactly that case: pg builds a Date by reading the server's
// wall clock as LOCAL time, so the JavaScript value is already a different
// instant from the stored one before lit is ever called, and a test that starts
// from the JS value can never see it.
//
// So this seeds with a SQL literal, reads it the way the dump reads it, writes
// the literal the dump would write, loads it into a second table of the same
// type, and compares the SERVER'S OWN text rendering of both. No JavaScript
// value is trusted anywhere in the comparison.
async function dumpAndRestore(sqlType, seedSql) {
  const stamp = Math.random().toString(36).slice(2, 10);
  const live = `live_${stamp}`;
  const restored = `restored_${stamp}`;
  await client.query(`CREATE TABLE ${live} (v ${sqlType})`);
  await client.query(`CREATE TABLE ${restored} (v ${sqlType})`);
  await client.query(`INSERT INTO ${live} (v) VALUES (${seedSql})`);

  const { rows: [{ typname }] } = await client.query(
    `SELECT t.typname FROM pg_attribute a
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = $1::regclass AND a.attname = 'v'`,
    [live]
  );
  const { rows: [read] } = await client.query({ text: `SELECT v FROM ${live}`, types: DUMP_TYPES });
  const literal = lit(read.v, typname);
  await client.query(`INSERT INTO ${restored} (v) VALUES (${literal})`);

  const textOf = async (t) => (await client.query(`SELECT v::text AS x FROM ${t}`)).rows[0].x;
  return { before: await textOf(live), after: await textOf(restored), literal, typname };
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
  // THE DISTINCTION THE 2026-08-13 BUG TURNED ON. pg parses a jsonb column
  // holding a JSON array into a JavaScript array, identically to how it parses
  // a text[] column. So the JS value cannot tell you which one you have, and a
  // serializer that guesses from it writes Postgres array syntax into a jsonb
  // column or JSON into a text[] column. Only the COLUMN type answers it.
  //
  // SEEDED IN SQL AND COMPARED IN SQL, since 2026-08-26. The first version of
  // this test started from a JavaScript value, and that shape is blind to the
  // half of the trip that goes wrong first: whether the DRIVER'S READ can carry
  // the value at all. It cannot, for four of the six top-level JSON forms, and
  // the four are not exotic. See TEXT_ONLY_OIDS in scripts/dump-db.js for the
  // measured failures; the short version is that three of them abort the whole
  // restore and the fourth turns JSON null into SQL NULL with no error, which
  // is the silent kind this file exists to catch.
  const cases = [
    [`'{}'`, 'an empty JSON object'],
    [`'[]'`, 'an empty JSON array'],
    [`'["a","b"]'`, 'a JSON array of strings, the shape that collides with text[]'],
    [`'[1,2,3]'`, 'a JSON array of numbers'],
    [`'{"tier":"pro","seats":4}'`, 'a JSON object'],
    [`'{"nested":{"a":[1,{"b":"c"}]}}'`, 'nesting'],
    [`'{"quote''d":"it''s fine"}'`, 'single quotes, which must be doubled'],
    [`'{"note":"has \\"double\\" quotes"}'`, 'double quotes inside JSON'],
    [`'{"a":"café 🕊"}'`, 'non-ASCII inside JSON'],
    // The four the driver's read used to destroy. A jsonb column accepts every
    // one of them and this schema's columns are all typed, not shaped.
    [`'5'`, 'a top-level number, which lit wrote as bare 5 into a jsonb column'],
    [`'-1.5e3'`, 'a top-level float'],
    [`'true'`, 'a top-level boolean, which lit wrote as TRUE'],
    [`'"hello"'`, 'a top-level string, which lit wrote unquoted as JSON'],
    [`'null'`, 'a top-level JSON null, which lit turned into a SQL NULL SILENTLY'],
  ];

  for (const [seed, what] of cases) {
    const r = await dumpAndRestore('jsonb', seed);
    assert.equal(r.after, r.before, `jsonb round trip failed for ${what}: literal was ${r.literal}`);
  }

  // json, not jsonb: a distinct type OID, a distinct parser registration, and
  // unlike jsonb it preserves the exact bytes, so a restore that reformats is
  // visible here and nowhere else.
  for (const [seed, what] of [
    [`'{ "a" : [1, 2], "b" : null }'`, 'json keeps its own spacing'],
    [`'null'`, 'a top-level json null'],
    [`'5'`, 'a top-level json number'],
  ]) {
    const r = await dumpAndRestore('json', seed);
    assert.equal(r.after, r.before, `json round trip failed for ${what}: literal was ${r.literal}`);
  }

  // AND JSON NULL IS NOT SQL NULL, stated on its own because it is the case
  // that fails without raising anything. A dump that flattens the two answers
  // `WHERE col IS NULL` differently after a restore than before it.
  const jsonNull = await dumpAndRestore('jsonb', `'null'`);
  assert.equal(jsonNull.before, 'null', 'the seed must actually be a JSON null, not a SQL NULL');
  assert.notEqual(jsonNull.literal, 'NULL',
    'a JSON null is being written as the SQL keyword NULL again. The column comes back SQL NULL, no '
    + 'error is raised at any point, and nothing downstream can tell the restore changed the row.');

  // An array column and a jsonb column holding the same JavaScript value still
  // take different literals, which is the original regression in one line.
  assert.equal(lit(['a', 'b'], '_text'), `'{"a","b"}'`);
  assert.equal(lit(['a', 'b'], 'jsonb'), `'["a","b"]'`);
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

  // timestamptz still starts from a Date here, because a Date is what a CALLER
  // hands the app and this line is about lit() writing one correctly. It reads
  // back as TEXT now, not as a Date, because the dump stopped parsing this type
  // on 2026-08-26: see TEXT_ONLY_OIDS, and see the dedicated test above for the
  // microseconds, the infinities and the years a Date cannot carry at all.
  // This assertion is deliberately kept and deliberately NOT trusted as the
  // proof for this type — believing it was is what let the loss stand.
  const ts = await roundTrip('timestamptz', now);
  assert.equal(
    new Date(`${String(ts.back).replace(' ', 'T')}`.replace(/([+-]\d\d)$/, '$1:00')).toISOString(),
    now.toISOString(),
    'timestamptz written from a JS Date must still land on the same instant'
  );

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

test('a naive timestamp comes back as the same wall clock it went in as', async () => {
  // THE SECOND WAY THIS FILE DID NOT RESTORE, found 2026-08-26 by asking the
  // question the first version of this suite did not: it round-tripped
  // `timestamptz` and stopped, and `timestamptz` is the one timestamp type that
  // already worked. Twenty columns in this schema are `timestamp WITHOUT time
  // zone`: users.created_at, flocks.event_time, messages.created_at,
  // stories.expires_at among them, and every one of them moved by the dumping
  // machine's UTC offset on restore. Four hours, on this box, with no error.
  //
  // Each case is a value Postgres stores and a Date cannot carry back:
  const cases = [
    [`'2026-08-13 19:44:32.725'`, 'an ordinary row timestamp'],
    [`'2026-03-08 02:30:00'`, 'the spring-forward gap, an hour that does not exist in local time'],
    [`'2026-11-01 01:30:00'`, 'the fall-back hour, which happens twice in local time'],
    [`'2026-12-31 23:59:59.999999'`, 'microseconds, which a JS Date truncates'],
    [`'1999-01-01 00:00:00'`, 'a date before this machine\'s current DST rule'],
    [`'infinity'`, 'infinity, which new Date() cannot represent and toISOString() throws on'],
    [`'-infinity'`, 'negative infinity'],
  ];
  for (const [seed, what] of cases) {
    const r = await dumpAndRestore('timestamp', seed);
    assert.equal(r.after, r.before,
      `a naive timestamp did not survive the trip (${what}): the database held ${r.before}, `
      + `the dump wrote ${r.literal}, and the restore produced ${r.after}. `
      + 'flocks.event_time is the time a plan is FOR, so this is every plan in the product '
      + 'moving by the offset of whichever machine took the backup.');
  }
});

test('a timestamptz keeps its microseconds, its infinities and its out-of-Date years', async () => {
  // THE THIRD WAY THIS FILE DID NOT RESTORE, found 2026-08-26 by asking the
  // question the timestamp fix answered for the naive type and then explicitly
  // declined to ask for this one. TEXT_ONLY_OIDS said, in so many words:
  // "timestamptz is deliberately NOT in this list ... that one already
  // round-trips exactly (proved in dumpLiteralRestore.test.js)". The proof it
  // cited was `roundTrip('timestamptz', new Date(...))` in the scalar test
  // above, which starts from a JavaScript Date and therefore cannot see a loss
  // the DRIVER'S READ has already caused. That is the identical blind spot the
  // jsonb cases were rewritten to close, on the identical argument, in the
  // commit immediately before this one.
  //
  // A Date holds MILLISECONDS. Postgres holds MICROSECONDS. This schema has 85
  // timestamptz columns and most of them are `DEFAULT NOW()`, so the value that
  // did not survive is not an edge case, it is what nearly every row holds.
  const cases = [
    [`'2026-08-13 19:44:32.725123+00'`, 'microseconds, which is what NOW() writes into 85 columns of this schema'],
    [`'2026-08-13 19:44:32.725+00'`, 'milliseconds, the precision a Date happens to survive'],
    [`'infinity'`, 'infinity, which pg parses to the NUMBER Infinity and lit() turned into a SQL NULL'],
    [`'-infinity'`, 'negative infinity, the same'],
    [`'0001-01-01 00:00:00+00 BC'`, 'a BC date, whose toISOString() is year 0000 and ABORTS the restore'],
    [`'12026-08-13 00:00:00+00'`, 'a year past 9999, whose expanded toISOString() ABORTS the restore'],
    [`NULL`, 'a real SQL NULL, which must stay one'],
  ];
  for (const [seed, what] of cases) {
    const r = await dumpAndRestore('timestamptz', seed);
    assert.equal(r.after, r.before,
      `a timestamptz did not survive the trip (${what}): the database held ${r.before}, the dump wrote `
      + `${r.literal}, and the restore produced ${r.after}. Every created_at, updated_at, expires_at and `
      + 'settled_at in this schema is this type.');
  }

  // AND THE ARRAY FORM, which goes with it for the same reason _timestamp goes
  // with timestamp. A NULL element beside a value is the case that separates a
  // correct array writer from one that flattens.
  for (const [seed, what] of [
    [`ARRAY['2026-08-13 19:44:32.725123+00'::timestamptz, NULL, 'infinity'::timestamptz]`,
      'timestamptz[] carrying microseconds, a real NULL element and an infinity'],
    [`'{}'::timestamptz[]`, 'an EMPTY timestamptz[], which is not NULL'],
  ]) {
    const r = await dumpAndRestore('timestamptz[]', seed);
    assert.equal(r.after, r.before, `timestamptz[] round trip failed for ${what}: literal was ${r.literal}`);
  }

  // The INSTANT is what a timestamptz means, so the claim has to hold when the
  // dumping session and the restoring session sit in different zones — which is
  // the ordinary case, a dump taken against Railway (UTC) and replayed from a
  // laptop, or the reverse. The server's text form carries an explicit offset,
  // which is the whole reason this works; a bare wall clock would not, and that
  // is the difference between this type and the naive one above.
  const stamp = Math.random().toString(36).slice(2, 10);
  const live = `tzlive_${stamp}`;
  const restored = `tzrest_${stamp}`;
  await client.query(`CREATE TABLE ${live} (v timestamptz)`);
  await client.query(`CREATE TABLE ${restored} (v timestamptz)`);
  await client.query(`INSERT INTO ${live} (v) VALUES ('2026-08-13 19:44:32.725123+00')`);
  try {
    for (const [dumpTz, restoreTz] of [
      ['UTC', 'UTC'],
      ['America/New_York', 'UTC'],
      ['UTC', 'Asia/Kolkata'],
      ['America/New_York', 'Asia/Kolkata'],
      ['Australia/Lord_Howe', 'America/Anchorage'],
    ]) {
      await client.query(`SET TIME ZONE '${dumpTz}'`);
      const { rows: [read] } = await client.query({ text: `SELECT v FROM ${live}`, types: DUMP_TYPES });
      const literal = lit(read.v, 'timestamptz');
      await client.query(`SET TIME ZONE '${restoreTz}'`);
      await client.query(`TRUNCATE ${restored}`);
      await client.query(`INSERT INTO ${restored} (v) VALUES (${literal})`);
      await client.query(`SET TIME ZONE 'UTC'`);
      const before = (await client.query(`SELECT v::text AS x FROM ${live}`)).rows[0].x;
      const after = (await client.query(`SELECT v::text AS x FROM ${restored}`)).rows[0].x;
      assert.equal(after, before,
        `a timestamptz dumped under ${dumpTz} and restored under ${restoreTz} landed on a different instant: `
        + `${before} -> ${after} via ${literal}`);
    }
  } finally {
    // Every other test in this file reads `v::text`, which for this type is
    // rendered in the SESSION's zone. Leaving a zone set here would change what
    // they compare.
    await client.query(`SET TIME ZONE 'UTC'`);
  }
});

test('a date column survives the trip whatever side of UTC the dumping machine is on', async () => {
  // date has the same defect in waiting. It happens to survive at a negative
  // UTC offset, because local midnight rendered as UTC lands later the same
  // day; at a POSITIVE offset it lands on the day before. The dump is not
  // guaranteed to be taken from America/New_York, so this is pinned rather than
  // left to the machine.
  for (const seed of [`'2026-08-13'`, `'2026-01-01'`, `'2026-12-31'`]) {
    const r = await dumpAndRestore('date', seed);
    assert.equal(r.after, r.before, `a date moved: ${r.before} -> ${r.after} via ${r.literal}`);
  }
});

test('a time column survives the trip, including the edges only postgres accepts', async () => {
  // Migration 057's ml_sports_events.event_local_time is the schema's first
  // plain time column (game start on the venue's wall clock, stored as-is
  // per the naive-timestamp doctrine). pg hands time back as a string and no
  // zone applies to the type, so the trap here is not a shift but coverage:
  // midnight, microsecond precision, and 24:00:00, which postgres accepts
  // and renders as itself and which a naive normalizer would mangle.
  for (const seed of [`'19:30:00'`, `'00:00:00'`, `'23:59:59.999999'`, `'24:00:00'`]) {
    const r = await dumpAndRestore('time', seed);
    assert.equal(r.after, r.before, `a time moved: ${r.before} -> ${r.after} via ${r.literal}`);
  }
});

test('a float that is not finite keeps its value, and every other type still refuses to emit invalid SQL', async () => {
  // This test used to assert the opposite, on the argument that NaN and
  // Infinity "have no representation an integer column will take". True, and
  // irrelevant: pg only ever hands back a NaN from a float column, because
  // float4 and float8 are the only types that can hold one. So the old branch
  // was not declining to write an impossible value, it was turning a real
  // stored value into NULL. Silent loss, in a backup, blessed by a test.
  for (const seed of [`'NaN'`, `'Infinity'`, `'-Infinity'`]) {
    const r = await dumpAndRestore('float8', seed);
    assert.equal(r.after, r.before, `float8 ${seed} became ${r.after} via ${r.literal}`);
  }
  const r4 = await dumpAndRestore('real', `'NaN'`);
  assert.equal(r4.after, r4.before, 'float4 NaN');

  // And nowhere else. A quoted 'NaN' in an integer column is an error that
  // aborts the whole restore at whatever table happens to contain it, so every
  // other type keeps the NULL, which loses a value that genuinely could not
  // have been stored there in the first place.
  for (const t of ['int4', 'int8', 'numeric', 'text', undefined]) {
    assert.equal(lit(NaN, t), 'NULL', `lit(NaN, ${t})`);
    assert.equal(lit(Infinity, t), 'NULL', `lit(Infinity, ${t})`);
  }
});

test('the remaining column types this schema holds survive the trip', async () => {
  // The types the sweep below finds that the cases above do not already cover
  // one at a time. Seeded as SQL and compared as SQL, for the reason
  // dumpAndRestore's own comment gives.
  const cases = [
    ['numeric(10,2)', `'12345678.91'`, 'bill_split_shares.amount, a user-typed money value'],
    ['numeric', `'NaN'`, 'numeric NaN, which unlike float8 has always round-tripped as a quoted string'],
    ['int8', `9007199254740993`, 'a bigint past 2^53, where a JS number stops being exact'],
    ['int2', `-32768`, 'the smallest smallint'],
    ['uuid', `'0f8fad5b-d9cb-469f-a165-70867728950e'`, 'guest_rsvps.guest_token'],
    ['varchar(20)', `'a''b\\c'`, 'a varchar holding a quote and a backslash'],
    // QUOTED, and that is the whole case. This line used to seed an UNQUOTED
    // -0.0 and call itself "negative zero". Postgres parses an unquoted -0.0 as
    // a NUMERIC, numeric has no signed zero, and the cast to float8 hands over
    // a POSITIVE zero — `SELECT (-0.0)::float8::text` is "0" — so the assertion
    // passed against a value the test never created. A quoted literal goes
    // through float8in, which does produce a negative zero, and the writer then
    // lost it: String(-0) is "0" in JavaScript. Found 2026-08-26. This schema
    // has 24 `real` and 8 `double precision` columns.
    ['float8', `'-0.0'`, 'negative zero, which String() flattens to 0'],
    ['real', `'-0.0'`, 'float4 negative zero'],
    ['float8[]', `ARRAY['-0.0'::float8]`, 'a negative zero inside an array, which pgArrayBody flattened too'],
    ['float8', `5e-324`, 'the smallest subnormal double, where a lazy String() loses digits'],
    ['float8', `1.7976931348623157e308`, 'the largest finite double'],
    ['bytea', `'\\x0027225c0aff'`, 'bytea carrying a NUL, a quote and a backslash byte'],
    ['inet', `'203.0.113.9'`, 'inet, which this suite has always claimed to cover and did not'],
  ];
  for (const [sqlType, seed, what] of cases) {
    const r = await dumpAndRestore(sqlType, seed);
    assert.equal(r.after, r.before, `${what}: ${r.before} -> ${r.after} via ${r.literal}`);
  }
});

// ---------------------------------------------------------------------------
// AND THE LIST OF TYPES ITSELF, BUILT RATHER THAN REMEMBERED.
// ---------------------------------------------------------------------------
// Every claim above is about "the types this schema holds", and until this test
// existed that phrase was a person's memory of the schema. It was wrong: the
// file's own header listed `inet` among the types it round-trips, this database
// has no inet column at all, and the twenty `timestamp` columns it does have
// were not tested by anything.
//
// So the schema is built here, from the migration chain, and the set of column
// types it actually contains is compared against the set exercised above. A
// migration that introduces a type nobody has round-tripped fails this, which
// is the only way the sentence stays true.
//
// WHAT IT STILL CANNOT SEE, and the reason has to be written down because the
// list below looks complete. This measures TYPES, not VALUES. `jsonb` was in
// the list from the day it was written, and four of the six top-level JSON
// forms did not round-trip at all: three aborted the restore and one turned a
// JSON null into a SQL NULL without raising anything. A type is covered here
// the moment ONE value of it survives, so a covered type can still hold a value
// that does not. Nothing automatic closes that; the only defence is that each
// case above chooses its values by asking what the column can actually hold
// rather than what a caller happens to write today.
const ROUND_TRIPPED = new Set([
  '_text', 'bool', 'bytea', 'date', 'float4', 'float8', 'int2', 'int4', 'int8',
  'json', 'jsonb', 'numeric', 'text', 'time', 'timestamp', 'timestamptz', 'uuid', 'varchar',
]);

test('every column type the migration chain produces has a case in this file', async () => {
  const { Pool } = require('pg');
  const bootstrap = new Client({
    host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'postgres', ssl: false,
  });
  await bootstrap.connect();
  await bootstrap.query("CREATE DATABASE flock_dump_schema ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
  await bootstrap.end();

  const url = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_dump_schema`;
  const pool = new Pool({ connectionString: url, ssl: false });
  try {
    // The same entry point BACKUP-AND-VERIFICATION.md's restore procedure runs.
    // If the chain cannot build the schema on its own, the restore procedure is
    // false and this suite has nothing to measure against.
    await require('../db/migrate').migrate(pool);

    const { rows } = await pool.query(`
      SELECT t.typname, count(*)::int AS n, min(c.relname || '.' || a.attname) AS example
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
       GROUP BY t.typname
       ORDER BY t.typname`);

    assert.ok(rows.length >= 10,
      `the sweep found ${rows.length} column types, which means the chain did not build the schema`);

    const uncovered = rows.filter((r) => !ROUND_TRIPPED.has(r.typname));
    assert.deepEqual(uncovered.map((r) => `${r.typname} (${r.n} columns, e.g. ${r.example})`), [],
      'a migration has introduced a column type that nothing in this file round-trips through a real\n'
      + 'restore. Add a case to the tests above and the type name to ROUND_TRIPPED, or the backup\n'
      + 'silently starts carrying a type lit() has never been asked about. Two already went wrong this\n'
      + 'way: text[] (the ::jsonb cast, which made the whole file unrestorable) and timestamp (the\n'
      + 'four-hour shift), and both were invisible until somebody wrote the case down.\n\n'
      + 'interval is the one waiting: pg parses it into a plain object, lit falls through to\n'
      + 'JSON.stringify, and the restore dies on `invalid input syntax for type interval`. There is no\n'
      + 'interval column today, which is the only reason it is not a live defect.');

    // And the other direction, so the list cannot rot into naming types that
    // left the schema years ago.
    const live = new Set(rows.map((r) => r.typname));
    // float4/json are held deliberately: the schema has no column of either
    // today, and both are one migration away (a REAL score, a json payload).
    const stale = [...ROUND_TRIPPED].filter((t) => !live.has(t) && !['float4', 'json'].includes(t));
    assert.deepEqual(stale, [],
      'ROUND_TRIPPED names types this schema no longer has. A stale entry lets a real gap hide behind '
      + 'a list that looks complete.');
  } finally {
    await pool.end().catch(() => {});
  }
});
