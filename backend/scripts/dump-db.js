#!/usr/bin/env node
/**
 * Restorable database dump, with no pg_dump required.
 *
 * The old scripts/backup-data.js wrote `SELECT *` to JSON for a hand-written
 * table list that named two tables which never existed and omitted the entire
 * ML corpus. JSON also has no import path, so it was never actually a backup.
 *
 * This walks every table in the public schema (so it cannot fall out of date
 * the way a hardcoded list does), writes a CREATE TABLE IF NOT EXISTS for each
 * one, then INSERT statements in an order that respects foreign keys, and
 * resets every sequence at the end. Restore is:
 *
 *     DATABASE_URL="$TARGET" node db/migrate.js        # structure, from the repo
 *     psql "$TARGET" -v ON_ERROR_STOP=1 -f <output>    # data
 *
 * The DDL block is a no-op for every table the migrations build. It is there
 * for the tables they do NOT build: ml_training_data_weekly_w1, and the _w2 and
 * _w3 archives that follow it, are created at runtime by
 * scripts/ml/archiveWeeklyWindow.js, and a restore with only the migration
 * chain to go on died on them. See createTableStatement() for the full account.
 *
 * The migration chain builds the WHOLE schema on its own. This used to say
 * `psql -f database/schema.sql` instead, which is the thirteen bootstrap tables
 * and nothing after them, so the data load then died on the first table any
 * migration added. 000_bootstrap.sql already holds that file's exact content.
 *
 * ON_ERROR_STOP=1 is not decoration. Without it psql prints errors, keeps
 * going, exits 0, and hands back a half-restored database that looks fine.
 *
 * Usage:  node scripts/dump-db.js [outfile]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, types } = require('pg');

// ---------------------------------------------------------------------------
// THE COLUMNS WHOSE TEXT FORM IS THE ONLY FAITHFUL THING TO WRITE DOWN.
// ---------------------------------------------------------------------------
// node-pg turns `timestamp without time zone` into a JavaScript Date by reading
// the wall clock the server sent AS LOCAL TIME on the dumping machine. lit()
// then wrote that Date with toISOString(), which is UTC. Those two steps do not
// cancel: a row holding 19:44:32.725 was dumped as '2026-08-13T23:44:32.725Z'
// and restored, into a column with no time zone, as 23:44:32.725. Every naive
// timestamp in the file moved by the dumping machine's UTC offset, silently,
// with no error anywhere, measured on this box (America/New_York, +4h) before
// this line existed.
//
// This schema has twenty such columns and they are not decoration:
// users.created_at, flocks.created_at/updated_at, flocks.EVENT_TIME (the time
// the plan is actually FOR), flock_members.joined_at, messages.created_at,
// direct_messages.created_at, stories.created_at/expires_at,
// emergency_alerts.created_at, friendships.created_at. A restore shifted every
// plan four or five hours and gave every story four extra hours of life.
//
// The offset is not even constant: it is whatever the DUMPING machine's offset
// was for that particular instant, so a corpus spanning a DST change came back
// smeared by two different amounts, and a value inside the spring-forward gap
// (02:30 on the second Sunday in March, which Postgres stores happily and local
// time does not have) came back as 07:30 rather than 06:30.
//
// The fix is to never build a Date at all for these types. The server's own
// text form, '2026-08-13 19:44:32.725', is exactly what the column holds and
// exactly what restores into it, so the round trip is byte-for-byte. It also
// carries the two values a Date cannot represent at all: a `timestamp` column
// may hold 'infinity' and '-infinity', and `new Date('infinity')` is an Invalid
// Date whose toISOString() THROWS, which would have killed the dump outright.
//
// ---------------------------------------------------------------------------
// timestamptz IS IN THIS LIST, AND THE SENTENCE THAT KEPT IT OUT WAS WRONG.
// ---------------------------------------------------------------------------
// This paragraph used to read: "timestamptz is deliberately NOT in this list.
// Its Date carries an absolute instant, toISOString() writes it with a Z, and
// the restore reads the Z, so that one already round-trips exactly (proved in
// dumpLiteralRestore.test.js)." The word `exactly` was false, and so was the
// proof: the test it cited started from a JavaScript Date, which is the one
// shape that cannot see a loss the DRIVER'S READ has already caused, exactly
// as the json/jsonb note below says of its own case.
//
// Measured 2026-08-26 by seeding in SQL and comparing Postgres's own rendering
// of both sides:
//
//   timestamptz '...19:44:32.725123+00'   read as a Date, written as
//                                         '2026-08-13T19:44:32.725Z', restored
//                                         as ...725. THE 123 MICROSECONDS ARE
//                                         GONE, no error anywhere.
//   timestamptz 'infinity'                pg parses this to the NUMBER Infinity,
//   timestamptz '-infinity'               lit() sees a non-finite number in a
//                                         non-float column and writes NULL. The
//                                         column comes back SQL NULL, silently.
//   timestamptz '0001-01-01 BC'           toISOString() writes year 0000, which
//   timestamptz '12026-08-13'             Postgres refuses, and toISOString()
//                                         writes a six-digit expanded year for
//                                         the second, which it also refuses.
//                                         Both ABORT THE RESTORE.
//
// A Date holds milliseconds and Postgres holds microseconds, so the first one
// is not an edge case at all: this schema has EIGHTY-FIVE timestamptz columns
// and most of them are `DEFAULT NOW()`, which produces a microsecond value on
// every row. Every backup ever taken has been truncating all of them.
//
// The infinity pair is the same failure IN KIND as the JSON null below, and
// three lines under a comment that already names infinity as the value a Date
// cannot carry for the naive type. It was named there and missed here.
//
// The fix is the same one, for the same reason: read the server's own text.
// `2026-08-13 15:44:32.725123-04` carries an explicit offset, so the restore
// lands on the identical instant whatever TimeZone either session runs under.
// Verified across five dump/restore zone pairings, including a half-hour and a
// 30-minute-offset zone, plus both infinities, both out-of-Date-range years,
// timestamptz[] holding a NULL element beside a value, and an empty array.
//
// ---------------------------------------------------------------------------
// json AND jsonb ARE HERE FOR A SECOND REASON, FOUND 2026-08-26.
// ---------------------------------------------------------------------------
// The timestamp argument above is about the driver reading a value into the
// WRONG instant. This one is about the driver reading a value into a JavaScript
// type that lit() then cannot tell apart from anything else. pg parses a
// json/jsonb column with JSON.parse, and JSON has four top-level forms that are
// not an object or an array. Every one of them came back out wrong, measured
// against real Postgres columns:
//
//   jsonb '5'        parsed to 5,     written as bare 5     ERROR: column "v" is
//                                                           of type jsonb but
//                                                           expression is of
//                                                           type integer
//   jsonb 'true'     parsed to true,  written as TRUE       the same error
//   jsonb '"hello"'  parsed to 'hello', written as 'hello'  ERROR: invalid input
//                                                           syntax for type json
//   jsonb 'null'     parsed to null,  written as NULL       NO ERROR AT ALL, and
//                                                           the column comes
//                                                           back SQL NULL
//                                                           instead of JSON null
//
// The first three abort the whole restore at whatever table holds them, which
// is the exact failure the ::jsonb cast caused and this file was rewritten to
// end. The fourth is worse in kind, because it is the silent one: `SELECT ...
// WHERE col IS NULL` answers differently before and after a restore and nothing
// anywhere says so.
//
// The last one also cannot be fixed inside lit(), and that is why the fix is
// here rather than there. By the time lit() sees the value, JSON null and SQL
// NULL are both the JavaScript `null`; the information that told them apart was
// destroyed by the parser. Reading the column as the server's own text is what
// keeps it, and it is the same move, for the same reason, as the timestamps.
//
// NOT A LIVE DEFECT TODAY, exactly like the `interval` gap the coverage test
// names: every jsonb write path in this app is validated to an object or an
// array first (routes/messages.js and utils/venuePayload.js for venue_data,
// routes/venueProfile.js for operating_hours and notification_prefs,
// routes/users.js for user_settings.settings, services/pushHelper.js for
// push_outbox.data). One route that stores a bare number, string, boolean or
// JSON null makes the backup unrestorable, and nothing about that route would
// look wrong. The coverage test could not have caught this: it measures the set
// of column TYPES that round-trip, jsonb is in that set, and it was the VALUES
// inside one covered type that did not.
const TEXT_ONLY_OIDS = new Set([
  1082, // date
  1114, // timestamp without time zone
  1115, // timestamp without time zone[]
  1182, // date[]
  114,  // json
  199,  // json[]
  3802, // jsonb
  3807, // jsonb[]
  1184, // timestamp with time zone
  1185, // timestamp with time zone[]
]);
const identityParser = (v) => v;
// Passed per-query rather than through pg.types.setTypeParser, which is global
// to the process: requiring this module must not change how anything else in
// the same process reads a timestamp. That is the same rule the require.main
// guard at the bottom of this file exists to keep.
const DUMP_TYPES = {
  getTypeParser: (oid, format) => (
    TEXT_ONLY_OIDS.has(oid) ? identityParser : types.getTypeParser(oid, format)
  ),
};

// ---------------------------------------------------------------------------
// Where the dump is allowed to land.
//
// Security review: this file is not "user data", it is CREDENTIAL MATERIAL.
// A full dump contains users.password (bcrypt hashes), users.apple_refresh_token
// (a live Apple OAuth refresh token), device_tokens.token and
// flock_invite_links.token / guest_rsvps.guest_token (bearer capabilities — the
// push tokens let the holder notify any user, the link tokens let them join a
// private flock), and sensor_devices.api_key.
//
// Round 17 correction: this used to claim "password_reset_tokens.token (live
// reset tokens)". No such table exists. Migration 015 stores a reset as a SPLIT
// token — password_resets.selector is the public lookup half and verifier_hash
// is a SHA-256 of a secret half that is never written down — so a dump contains
// no usable reset link, and the same is true of email_verifications. Naming a
// table that does not exist in the one comment operators read before handling
// this file is how a warning stops being believed, so it is corrected rather
// than left generously vague.
//
// backend/backups/ is gitignored; nothing else in the worktree is. The optional
// [outfile] argument used to accept any path, so one `node scripts/dump-db.js
// dump.sql` from the repo root dropped every one of those credentials into a
// tracked directory, one `git add -A` away from a push. The dump is now pinned
// to the ignored directory unless the operator explicitly opts out with
// DUMP_ALLOW_ANY_PATH=1 (for writing to somewhere outside the repo entirely).
// ---------------------------------------------------------------------------
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const REPO_ROOT = path.join(__dirname, '..', '..');

const OUT = path.resolve(
  process.argv[2]
    || path.join(BACKUP_DIR, `flock-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.sql`)
);

// Round 17 re-audit: the first version of this compared paths case-SENSITIVELY,
// and path.resolve() preserves case on Windows down to the drive letter. So
// `node scripts/dump-db.js c:/users/jayden/flock-app/leak.sql` did not look like
// an in-repo path at all, and with DUMP_ALLOW_ANY_PATH=1 it was allowed to
// write a full credential dump into the tracked worktree. Measured, then fixed.
//
// Two comparators, because they are two different questions:
//  - "is this the gitignored backups directory": must follow the FILESYSTEM's
//    own rules. On Linux, backend/BACKUPS is a genuinely different directory
//    and .gitignore does not cover it, so matching it case-insensitively there
//    would allow exactly what this guard exists to stop.
//  - "is this inside the repo at all": always case-insensitive. Over-refusing a
//    path costs one retyped command; under-refusing costs a credential leak.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const under = (target, dir, fold) => {
  const t = fold ? target.toLowerCase() : target;
  const d = fold ? dir.toLowerCase() : dir;
  return t === d || t.startsWith(d + path.sep);
};
const withinBackups = (target) => under(target, BACKUP_DIR, CASE_INSENSITIVE_FS);
const withinRepo = (target) => under(target, REPO_ROOT, true);

function assertSafeOutputPath(target) {
  if (withinBackups(target)) return;

  // Round 17: the opt-out used to be the FIRST line of this function, so
  // DUMP_ALLOW_ANY_PATH=1 disabled every check including the one that matters.
  // Its own error message says the flag is for "writing to somewhere outside
  // the repo entirely" — now that is all it does. A committable path is the
  // single failure this guard exists to prevent, and no environment variable
  // should be able to wave it through, least of all one an operator sets once
  // and leaves exported in a shell for the rest of the session.
  const inRepo = withinRepo(target);
  if (!inRepo && process.env.DUMP_ALLOW_ANY_PATH === '1') return;

  console.error(
    `\nRefusing to write the dump to:\n  ${target}\n\n` +
    'A full dump contains bcrypt password hashes, Apple refresh tokens, push\n' +
    'device tokens, flock invite tokens and sensor API keys. Only backend/backups/\n' +
    `is gitignored, so ${inRepo ? 'that path is inside the repo and committable' : 'that path is outside the protected directory'}.\n\n` +
    `Write it to ${BACKUP_DIR}\n` +
    (inRepo
      ? 'Paths inside the repo are refused outright; DUMP_ALLOW_ANY_PATH does not cover them.\n'
      : 'or, if you really mean to write outside the repo, re-run with DUMP_ALLOW_ANY_PATH=1.\n')
  );
  process.exit(1);
}

// Column names whose values are credentials rather than user content. Matched
// against every column actually dumped, so a migration that adds a new secret
// column gets flagged without anyone remembering to update a list here.
const SENSITIVE_COLUMN = /password|secret|token|api_key|private_key|refresh/i;

// A second class, added in round 17 alongside migrations 011/012/015. These are
// NOT credentials — they are keyed HMACs and split-token halves whose secret
// counterpart was never stored, so nobody can replay them out of this file, and
// calling them credentials would dilute the warning above until it is ignored.
// They still need saying, because each one is retention-bound at the row level
// (banned_identities expires after 365 days; a verification or reset link dies
// in 24h or 1h) and a dump copies them somewhere with no expiry at all. The
// ban-evasion digests in particular are identity data about users who are
// frequently minors. Same principle as above: a regex over the columns that
// actually exist, not a list someone has to remember to extend.
const RETENTION_BOUND_COLUMN = /hash|digest|verifier|selector|email_key/i;

// Postgres ARRAY input syntax: {a,b}, elements always double-quoted so that
// commas, braces, backslashes, empty strings and the literal word NULL inside a
// value cannot change the parse. An unquoted NULL is a real SQL NULL element,
// which is why that one case is not quoted.
function pgArrayBody(arr) {
  return '{' + arr.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return pgArrayBody(v);
    const s = v instanceof Date ? v.toISOString()
      : Buffer.isBuffer(v) ? `\\x${v.toString('hex')}`
        : typeof v === 'object' ? JSON.stringify(v)
          // The signed zero, for the same reason lit() carries it: a float8[]
          // element that came out of Postgres as `-0` went back in as `0`.
          : Object.is(v, -0) ? '-0'
            : String(v);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }).join(',') + '}';
}

// Postgres literal escaping. Buffers become bytea hex, dates become ISO.
//
// ROUND 17 — THIS FILE DID NOT RESTORE.
// Every non-scalar was emitted as `'<json>'::jsonb`, and that explicit cast is
// what broke it: a TEXT[] column is not a jsonb column, so restoring a dump of
// any real database died on the FIRST table with
//   ERROR: column "interests" is of type text[] but expression is of type jsonb
// (users.interests, venue_profiles.goals, ml_venues.google_types are all
// TEXT[]). The tool's entire premise is the word "restorable" in its own
// docblock, and it was false — measured by dumping a populated database and
// replaying the output into a freshly migrated one.
//
// The fix is to stop guessing from the JavaScript value and use the type the
// server actually reported for the column (res.fields[i].dataTypeID), and to
// drop the cast. An UNTYPED quoted literal in INSERT ... VALUES is coerced to
// whatever the target column is, so one representation restores correctly into
// text[], jsonb, json, inet, or anything else added later — while `::jsonb`
// asserts a type the column may not have.
function lit(v, typeName) {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'`;
  if (v instanceof Date) return `'${v.toISOString()}'`;
  // Arrays: only when the COLUMN is an array type. pg parses a jsonb column
  // holding a JSON array into a JS array too, and that one must stay JSON.
  if (Array.isArray(v) && typeof typeName === 'string' && typeName.startsWith('_')) {
    return `'${pgArrayBody(v).replace(/'/g, "''")}'`;
  }
  if (typeof v === 'number') {
    // THE SIGNED ZERO, which String() flattens: String(-0) is "0".
    //
    // Quoted, and that is not a detail. An UNQUOTED -0 in an INSERT is parsed
    // by Postgres as an integer constant, which has no signed zero, so it
    // arrives at a float8 column as +0 and loses exactly what it was written to
    // keep. Only a quoted literal reaches float8in, which does produce one.
    // That is the same trap the test covering this case fell into for its whole
    // life: it seeded an unquoted -0.0 and asserted on a value it never made.
    //
    // Gated on the two types that can hold one, exactly like the NaN branch
    // below and for the same reason: pg only ever hands back a -0 from a float
    // column. Anything else is a plain 0.
    // Object.is is the only test that separates them; `v === 0` is true of both.
    if (Number.isFinite(v)) {
      if (Object.is(v, -0)) return (typeName === 'float4' || typeName === 'float8') ? `'-0'` : '0';
      return String(v);
    }
    // NaN and +/-Infinity ARE storable, in exactly two column types: float4 and
    // float8 accept them as quoted literals and hold them. This used to write
    // NULL for all of them on the argument that they were "never storable",
    // which is true of integer and false of the type they actually arrive in:
    // pg hands NaN back only from a float column, because that is the only kind
    // that can hold one. So the old branch turned a real stored value into NULL
    // on restore, silently, which is the one thing a backup may not do.
    // Everything else still becomes NULL rather than invalid SQL, because
    // `NaN` in an integer column aborts the whole restore at whatever table
    // happens to contain it.
    if (typeName === 'float4' || typeName === 'float8') return `'${String(v)}'`;
    return 'NULL';
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v) || typeof v === 'object') {
    return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// THE DUMP NOW CARRIES ITS OWN TABLE DEFINITIONS, AND THAT IS NOT DECORATION.
// ---------------------------------------------------------------------------
// Round 18 — THIS FILE DID NOT RESTORE, AGAIN, AND FOR A NEW REASON.
// The documented restore is `node db/migrate.js` (schema, from the migration
// chain) and then this file (data). That assumes every table this dumper finds
// is a table some migration creates. One is not:
//
//   scripts/ml/archiveWeeklyWindow.js
//     CREATE TABLE ml_training_data_weekly_w1 AS SELECT * FROM ml_training_data
//
// It is made ad hoc by a script, it holds 3,454,955 rows of the training corpus
// — the one asset in this company that cannot be rebuilt, because the vendor
// that supplied it is gone — and no migration mentions it. So the dump faithfully
// wrote 3.4 million rows into a file whose restore died on
//   ERROR: relation "ml_training_data_weekly_w1" does not exist
// after 7,947 statements, measured on the 2.74 GB dump taken 2026-09-03.
//
// The archive name carries the window number, so `_w2` and `_w3` arrive on their
// own schedule and would each break the restore the same way, months apart, with
// nobody having done anything wrong in between. A migration that creates `_w1`
// would fix today and nothing else, which is why the fix is here instead.
//
// CREATE TABLE IF NOT EXISTS is a NOTICE and a no-op for every table the
// migrations already built — which is all but one of them — so this changes
// nothing about the ordinary restore. What it changes is the case nobody
// remembered: a table that exists in production and in no .sql file now arrives
// in the dump with the definition it had when the rows were read.
//
// WHAT THIS DDL CARRIES AND WHAT IT DOES NOT. Columns, in attnum order, with
// their exact type, their default, and their NOT NULL. It does NOT carry primary
// keys, unique constraints, foreign keys, checks, indexes or ownership, and it
// is deliberately not trying to: this is a safety net for tables the migration
// chain does not create, not a second copy of the schema. The migration chain
// remains the source of truth for everything it does create, and the restore
// procedure is unchanged — run migrate.js first, exactly as before.
//
// The type text comes from format_type(), not from reassembling
// information_schema.columns. information_schema splits one type across five
// columns (data_type, udt_name, character_maximum_length, numeric_precision,
// numeric_scale) and rebuilding `character varying(50)`, `numeric(10,2)` or
// `text[]` out of them by hand is exactly the kind of near-miss that produces a
// table whose columns silently differ from production. format_type is the
// function pg_dump itself renders types with.
//
// Ordering inside the statement is `type DEFAULT x NOT NULL`, which is what
// pg_dump emits; Postgres accepts column constraints in any order.
function createTableStatement(table, cols) {
  const defs = cols.map((c) => {
    let def = `  "${c.column_name}" ${c.type}`;
    if (c.default_expr !== null && c.default_expr !== undefined) def += ` DEFAULT ${c.default_expr}`;
    if (c.not_null) def += ' NOT NULL';
    return def;
  });
  return `CREATE TABLE IF NOT EXISTS "${table}" (\n${defs.join(',\n')}\n);\n`;
}

async function main() {
  assertSafeOutputPath(OUT);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. It lives in backend/.env or the Railway Postgres service.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    // Railway's TCP proxy is slow to hand back the first packet and will drop
    // an idle socket mid-dump on a large table. Without the error handler an
    // 'error' event on the client is an unhandled throw that kills the process
    // halfway through writing the file.
    connectionTimeoutMillis: 30000,
    query_timeout: 300000,
    keepAlive: true,
  });
  client.on('error', (e) => console.error('pg client error:', e.message));
  await client.connect();

  // ONE SNAPSHOT FOR THE WHOLE DUMP.
  //
  // Every table used to be read in its own implicit snapshot, one
  // `SELECT * FROM t` at a time, against a live database that is still taking
  // writes. A flock created after `flocks` was read but before `flock_members`
  // was read produced a member row whose flock is not in the file: a foreign
  // key that dangles in the backup and nowhere else. The bigger the corpus the
  // wider the window, and this dump takes minutes.
  //
  // What made it worth fixing rather than tolerating is what happens next.
  // verify-backup.js sweeps every foreign key for orphans and FAILS the dump on
  // one, which is the correct response to a file it cannot vouch for, so the
  // outcome of a single unlucky write during a dump is that the backup is
  // thrown away. Retaking it is another few minutes and another roll of the
  // same dice.
  //
  // REPEATABLE READ takes one snapshot at the first statement and every read
  // after it sees exactly that instant, so the file is a picture of one moment
  // rather than a smear across several. It takes no locks and blocks no writer:
  // the app carries on serving while the dump runs, it simply does not appear
  // in the file. READ ONLY says out loud that this connection cannot write,
  // which on a script pointed at production is worth the four extra characters.
  //
  // The sequence setvals at the end are read inside this same snapshot, so they
  // match the rows that were written rather than a later maximum. That
  // direction was already safe (a setval ahead of the data only wastes ids) and
  // is now simply correct.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // Order tables so that a table is written after everything it references.
  // Self-references are ignored (they are nullable in this schema).
  const { rows: tables } = await client.query(`
    SELECT c.relname AS table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const { rows: fks } = await client.query(`
    SELECT c.relname AS child, f.relname AS parent
    FROM pg_constraint co
    JOIN pg_class c ON c.oid = co.conrelid
    JOIN pg_class f ON f.oid = co.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE co.contype = 'f' AND n.nspname = 'public' AND c.relname <> f.relname
  `);

  const names = tables.map((t) => t.table);
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const { child, parent } of fks) {
    if (deps.has(child) && names.includes(parent)) deps.get(child).add(parent);
  }
  const ordered = [];
  const seen = new Set();
  const visit = (n, stack = new Set()) => {
    if (seen.has(n) || stack.has(n)) return;   // cycle: emit in whatever order we reached it
    stack.add(n);
    for (const p of deps.get(n) || []) visit(p, stack);
    stack.delete(n);
    seen.add(n);
    ordered.push(n);
  };
  names.forEach((n) => visit(n));

  // Type name per column OID, so lit() can tell a text[] column from a jsonb
  // one holding a JSON array. Cheap: one query, ~600 rows.
  const { rows: pgTypes } = await client.query('SELECT oid, typname FROM pg_type');
  const typeNameByOid = new Map(pgTypes.map((t) => [Number(t.oid), t.typname]));

  // Every column of every dumped table, for the CREATE TABLE IF NOT EXISTS
  // block written below. Read inside the same REPEATABLE READ snapshot as the
  // rows, so the definition in the file is the definition the rows came out of.
  // Dropped columns are excluded (attisdropped): they are still physically
  // present in pg_attribute and SELECT * does not return them.
  const { rows: ddlCols } = await client.query(`
    SELECT c.relname   AS table_name,
           a.attname   AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS default_expr
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `);
  const colsByTable = new Map();
  for (const c of ddlCols) {
    if (!colsByTable.has(c.table_name)) colsByTable.set(c.table_name, []);
    colsByTable.get(c.table_name).push(c);
  }

  // 0600: the dump holds live credentials, so it is readable only by the user
  // that produced it. (No-op on Windows; correct everywhere the dump is likely
  // to be taken from, which is a Linux shell against the Railway proxy.)
  //
  // Round 17: the `mode` option only applies when open(2) actually CREATES the
  // file. Re-running a dump over a path that already exists — the same filename
  // twice, or a file someone else left there — kept the OLD permissions, so the
  // one case where the mode matters most (a world-readable leftover) was
  // exactly the case it did not cover. chmod unconditionally after opening.
  const out = fs.createWriteStream(OUT, { mode: 0o600 });
  try { fs.chmodSync(OUT, 0o600); } catch (_) { /* Windows / non-POSIX fs */ }
  const write = (s) => new Promise((res) => (out.write(s) ? res() : out.once('drain', res)));

  await write(`-- Flock data dump ${new Date().toISOString()}\n`);
  await write(`-- Restore: DATABASE_URL="$TARGET" node db/migrate.js  (builds the whole schema),\n`);
  await write(`--          then: psql "$TARGET" -v ON_ERROR_STOP=1 -f this-file\n`);
  await write(`-- Full procedure, including what a restore does NOT bring back: BACKUP-AND-VERIFICATION.md\n`);
  await write(`BEGIN;\nSET session_replication_role = replica;\n\n`);

  // Table definitions, before any INSERT and inside the same transaction as
  // them. See createTableStatement() above for why this block exists: one table
  // in this database is created by a script rather than by a migration, so a
  // restore built from the migration chain alone had nowhere to put 3.4 million
  // rows of the ML corpus. IF NOT EXISTS makes every other line here a no-op.
  await write('-- Table definitions. IF NOT EXISTS, so these are a no-op for every\n');
  await write('-- table db/migrate.js already built; they exist for the tables it does\n');
  await write('-- not build, such as the ml_training_data_weekly_* corpus archives.\n');
  let ddlWritten = 0;
  for (const table of ordered) {
    const cols = colsByTable.get(table);
    if (!cols || !cols.length) continue;
    await write(createTableStatement(table, cols));
    ddlWritten++;
  }
  await write('\n');

  let grand = 0;
  const counts = [];
  // Reported at the end so the operator knows, concretely and per run, what
  // they are now holding — the set grows whenever a migration adds a column,
  // which is exactly when a stale comment would have stopped being true.
  const credentialColumns = new Set();
  const retentionColumns = new Set();
  for (const table of ordered) {
    // DUMP_TYPES, not the default parsers: see TEXT_ONLY_OIDS at the top of the
    // file. Every naive timestamp in this schema was moving by the dumping
    // machine's UTC offset before this argument was passed.
    const res = await client.query({ text: `SELECT * FROM "${table}"`, types: DUMP_TYPES });
    const rows = res.rows;
    if (!rows.length) { counts.push([table, 0]); continue; }
    // From res.fields, not Object.keys(rows[0]): the field list carries the
    // column type the server reported, and it is also the only correct source
    // when a row happens to hold JS `undefined` for a column.
    const cols = res.fields.map((f) => f.name);
    const colType = res.fields.map((f) => typeNameByOid.get(f.dataTypeID));
    for (const c of cols) {
      if (SENSITIVE_COLUMN.test(c)) credentialColumns.add(`${table}.${c}`);
      else if (RETENTION_BOUND_COLUMN.test(c)) retentionColumns.add(`${table}.${c}`);
    }
    const collist = cols.map((c) => `"${c}"`).join(', ');
    await write(`-- ${table} (${rows.length})\n`);
    // Batch so a huge table does not become one unreadable statement.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = chunk
        .map((r) => `(${cols.map((c, ci) => lit(r[c], colType[ci])).join(', ')})`)
        .join(',\n  ');
      await write(`INSERT INTO "${table}" (${collist}) VALUES\n  ${values}\nON CONFLICT DO NOTHING;\n`);
    }
    await write('\n');
    counts.push([table, rows.length]);
    grand += rows.length;
  }

  // Sequences: without this every SERIAL id collides on the first insert after a restore.
  const { rows: seqs } = await client.query(`
    SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'
  `);
  if (seqs.length) {
    await write('-- sequences\n');
    for (const { sequence_name } of seqs) {
      const { rows } = await client.query(`SELECT last_value, is_called FROM "${sequence_name}"`);
      const { last_value, is_called } = rows[0];
      await write(`SELECT setval('"${sequence_name}"', ${last_value}, ${is_called ? 'true' : 'false'});\n`);
    }
    await write('\n');
  }

  await write(`SET session_replication_role = DEFAULT;\nCOMMIT;\n`);
  await new Promise((res) => out.end(res));
  // Close the read-only snapshot opened before the first SELECT. COMMIT rather
  // than ROLLBACK because nothing was written and a committed read-only
  // transaction is the ordinary end of one; either would release it, and
  // client.end() would too, but leaving it to the socket teardown is how a
  // long-lived snapshot ends up pinning vacuum on a database nobody is looking
  // at. The COMMIT above this line is text going into the dump FILE, which is
  // a different thing entirely.
  await client.query('COMMIT');
  await client.end();

  const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
  console.log(`\nWrote ${OUT}  (${mb} MB, ${grand} rows across ${ordered.length} tables,\n  plus CREATE TABLE IF NOT EXISTS for ${ddlWritten} of them)\n`);
  counts.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`  ${String(n).padStart(8)}  ${t}`));
  const empty = counts.filter(([, n]) => n === 0).map(([t]) => t);
  if (empty.length) console.log(`\n  empty: ${empty.join(', ')}`);

  if (credentialColumns.size || retentionColumns.size) {
    const block = ['\n  ------------------------------------------------------------------'];
    if (credentialColumns.size) {
      block.push(
        '  This file contains CREDENTIALS in cleartext, not just user data:',
        ...[...credentialColumns].sort().map((c) => `    - ${c}`)
      );
    }
    if (retentionColumns.size) {
      block.push(
        credentialColumns.size ? '' : '  This file contains regulated material, not just user data:',
        '  It also copies digest and link-record columns out of their retention',
        '  window. They expire in the database and not in this file, and',
        '  banned_identities is identity data about users who are often minors.',
        '  Treat them as sensitive even though they are hashes:',
        ...[...retentionColumns].sort().map((c) => `    - ${c}`)
      );
    }
    block.push(
      '',
      '  Treat it like a password vault: do not commit it, do not paste it',
      '  into an issue or a chat, and delete it when the restore is done.',
      '  ------------------------------------------------------------------'
    );
    console.log(block.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// Exported so the literal writers can be tested, and guarded so requiring this
// file does not take a dump as a side effect.
//
// This is not tidiness. `lit()` decides whether the backup restores, and until
// 2026-08-26 nothing tested it, because nothing COULD: the module ran main() at
// import and exported nothing, so the only way to exercise it was to dump a
// real database by hand and read the output. That is why the `::jsonb` bug
// (round 17, above) shipped, and it is why it then sat undetected inside the
// only backup that existed. __tests__/dumpLiteralRestore.test.js now replays
// this function's output into real Postgres columns of every type this schema
// holds, which is the check that would have caught it on the day.
// DUMP_TYPES is exported for the same reason: the decision to read a naive
// timestamp as text rather than as a Date is half of whether the file restores,
// and a test that used the default parsers would be testing a different dump
// from the one this script takes.
module.exports = { lit, pgArrayBody, createTableStatement, DUMP_TYPES, TEXT_ONLY_OIDS };

if (require.main === module) {
  main().catch((err) => { console.error('Dump failed:', err.message); process.exit(1); });
}
