// ---------------------------------------------------------------------------
// Versioned migrations. Files in backend/migrations/*.sql run in name order,
// once each, recorded in schema_migrations.
//
// Three modes, chosen by a directive on the FIRST line:
//  - default: the whole file runs in ONE transaction; any error rolls back,
//    logs loudly, and FAILS THE BOOT. No more silent partially-migrated
//    deployments (the old inline runner swallowed errors per-group).
//  - `-- @tolerant`: statements run one-by-one and errors are logged but
//    skipped. Reserved for 001_baseline.sql, which replays the historical
//    idempotent DDL against databases in unknown drift states.
//  - `-- @noTransaction`: statements run one-by-one, each autocommitting, and
//    the FIRST error fails the boot. For DDL that cannot live in a transaction
//    block (CREATE INDEX CONCURRENTLY) or that must not share one
//    (ADD CONSTRAINT NOT VALID + VALIDATE — see 004).
//
// The whole run happens on ONE dedicated connection so the session-level
// advisory lock and the session timeouts below actually apply to every
// statement (round 12: tolerant mode used to borrow arbitrary pool
// connections, where a `SET` would not stick).
//
// POST-CONDITIONS (`-- @requires`). "The batch returned without throwing" is a
// weaker fact than it looks, and two files proved it. 032 and 038 wrap every
// `ALTER TABLE` in `DO $$ ... EXCEPTION WHEN others THEN NULL`, so a
// lock_timeout on a busy table (this runner sets one, deliberately, at 10s)
// raised, was swallowed, and the file was recorded as applied with its columns
// absent. Nothing retries a migration the runner believes is done, so
// `routes/feedback.js` and `routes/crowd.js` would have gone on reading columns
// that were never going to appear. A file can therefore declare what it must
// leave behind:
//
//   -- @requires table served_predictions
//   -- @requires column venue_feedback.served_prediction_id
//
// and the runner does two things with that. It VERIFIES the requirements after
// running the file and before writing the schema_migrations row, so a swallowed
// failure cannot be recorded as success. And on every boot it RE-VERIFIES them
// for files already recorded, so a database that was already falsely marked
// heals itself: the file is applied AGAIN, in its own transaction, with its
// schema_migrations row left exactly where it was.
//
// THE HEAL NEVER DELETES THAT ROW, and the reason is measured. An earlier
// version deleted it in autocommit, before the re-apply transaction opened, and
// it deleted the row of EVERY unsatisfied file before applying any of them. One
// locked table therefore took the whole set down: the DELETE committed on its
// own, the re-apply hit the 10s lock_timeout, the ROLLBACK could not restore a
// row that had never been inside that transaction, and the boot threw. Against
// embedded Postgres 18 with `LOCK TABLE venue_feedback IN ACCESS EXCLUSIVE
// MODE` held on a second connection, which is exactly the rolling-deploy
// contention the heal was written for, the service went from degraded but
// serving (returned in 23ms) to never booting at all (threw after 10,020ms),
// and every boot after that repeated it with the row now permanently gone.
// server.js awaits this before server.listen().
//
// So: a heal repairs a database that is ALREADY degraded, and it may only ever
// improve it. Failing to repair is NOT fatal. It is logged loudly, the row and
// the missing column are left exactly as they were found, the service boots
// degraded the way it did before any of this existed, and the next boot tries
// again. Each file is repaired independently, so contention on one table cannot
// cost a different migration its row. Declaring @requires is a promise that the
// file is safe to run twice, which every file in this directory already has to
// be (__tests__/migrationBootSafety.test.js wipes schema_migrations and replays
// the whole chain over live data).
//
// A LATER MIGRATION THAT DROPS SOMETHING AN EARLIER ONE REQUIRES does not make
// the two "fight on every boot". The note that used to sit here said it did,
// and being wrong about that hid something worse. Measured over four boots with
// a synthetic 046 dropping a required column: boot 1 returned with the column
// gone, boot 2 SILENTLY PUT IT BACK, boots 3 and 4 said nothing at all, both
// files stayed recorded as applied, and no error was ever raised. Silently
// undoing a deliberate drop is far harder to notice than a fight would be. So
// the runner now reads the drops out of every file: a requirement declared by A
// is VOIDED as soon as a file sorting after A drops that table or that column,
// the heal leaves it alone, and startup logs which file voided which line so
// the stale `@requires` can be deleted from the source.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

// Fixed app-wide key for pg_advisory_lock — serializes migration runs across
// replicas / rolling deploys so two boots can't race the same file.
const MIGRATION_LOCK_KEY = 727501842;

// Round 12 (migration safety): a rolling deploy must not be able to block
// forever. The advisory lock is polled with pg_try_advisory_lock against a
// deadline rather than waited on indefinitely, lock_timeout stops any DDL from
// queueing behind a long-running query (which would also stall everything
// arriving after it), and statement_timeout caps a single runaway statement.
// Losing the race is a clean FATAL: server.js exits and the platform restarts
// us, which is recoverable — a wedged boot is not.
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 1_000;
const LOCK_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 300_000; // generous: covers a CONCURRENTLY build

// What `-- @requires table x` accepts as x. Anything you can name in a FROM
// clause: ordinary tables, partitioned tables, views, materialized views and
// foreign tables. The old check filtered `relkind IN ('r', 'p')`, so a view
// could never satisfy a requirement and a file that created one would fail its
// own post-condition forever. That was an accident of the query, not a decision
// anyone made; this is the decision. The same set is used for the column check,
// so `-- @requires column some_view.some_col` works too.
const REQUIRABLE_RELKINDS = ['r', 'p', 'v', 'm', 'f'];

async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await acquireLock(client);
    try {
      await runMigrations(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
  } finally {
    // DESTROY, never release (round 17 audit). The two SETs above are
    // SESSION-level, and `client.release()` hands that same backend straight
    // back to the pool with them still applied — measured, not theorised: after
    // a boot, `SHOW statement_timeout` on the first pooled connection returned
    // `5min` instead of the pool's 15s, and `lock_timeout` was 10s instead of 0.
    // config/database.js caps statements at 15s precisely so one query blocked
    // on a lock cannot park a pool slot forever; leaking the migration's 300s
    // made one of the twenty slots 20x looser for the whole life of the
    // process, and it was the slot at the head of the idle list, so it was the
    // one the first requests after boot actually got. Passing `true` closes the
    // backend instead; the pool opens a clean one on demand, which at boot
    // costs a single connection handshake.
    client.release(true);
  }
}

async function acquireLock(client) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATION_LOCK_KEY]);
    if (rows[0].ok) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `could not acquire the migration advisory lock within ${LOCK_WAIT_MS}ms — another instance is still migrating`
      );
    }
    console.log('[migrate] another instance holds the migration lock, waiting...');
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

// ---------------------------------------------------------------------------
// One scanner, two views of a file.
// ---------------------------------------------------------------------------
// Everything that reads SQL in this file reads it through here, because the
// three things that have to be told apart, code and string literals and
// comments, cannot be told apart by a regex. `splitStatements` already tracked them and
// was correct; `parseRequirements` did not track them at all and was not.
//
// Returns two same-length strings, so an offset in either one still maps to the
// same line of the original:
//   comments: TOP-LEVEL line comments verbatim, everything else blanked. A
//             `--` inside a $$ body, a /* */ block or a string literal is not
//             a top-level line comment and does not appear here.
//   code:     SQL with comments and string-literal CONTENTS blanked. Dollar
//             quoted bodies are kept, because that is where 032/038/044/045 put
//             their DDL and a DROP hidden in one still drops.
function scanSql(sql) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let comments = '';
  let code = '';
  const emit = (text, opts) => {
    comments += opts.comment ? text : blank(text);
    code += opts.code ? text : blank(text);
  };

  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    if (inLineComment) {
      emit(ch, { comment: true });
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (two === '*/') { emit(two, {}); i += 2; inBlockComment = false; continue; }
      emit(ch, {}); i += 1;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { emit(dollarTag, { code: true }); i += dollarTag.length; dollarTag = null; continue; }
      emit(ch, { code: true }); i += 1;
      continue;
    }
    if (inSingle) {
      emit(ch, {});
      if (ch === "'") {
        if (sql[i + 1] === "'") { emit("'", {}); i += 2; continue; }
        inSingle = false;
      }
      i += 1;
      continue;
    }
    if (two === '--') { inLineComment = true; emit(two, { comment: true }); i += 2; continue; }
    if (two === '/*') { inBlockComment = true; emit(two, {}); i += 2; continue; }
    if (ch === "'") { inSingle = true; emit(ch, {}); i += 1; continue; }

    const dollar = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
    if (dollar) { dollarTag = dollar[0]; emit(dollarTag, { code: true }); i += dollarTag.length; continue; }

    emit(ch, { code: true });
    i += 1;
  }

  return { comments, code };
}

// Split a file into statements on top-level semicolons. Aware of single-quoted
// strings, dollar-quoted bodies (DO $$ ... $$, which contain their own
// semicolons) and comments — the old naive `split(/;\s*\n/)` tore DO blocks in
// half, which is why comment/no-transaction files could not use them.
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    if (inLineComment) {
      buf += ch;
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (two === '*/') { buf += two; i += 2; inBlockComment = false; continue; }
      buf += ch; i += 1;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { buf += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      buf += ch; i += 1;
      continue;
    }
    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { buf += "'"; i += 2; continue; } // escaped quote
        inSingle = false;
      }
      i += 1;
      continue;
    }
    if (two === '--') { inLineComment = true; buf += two; i += 2; continue; }
    if (two === '/*') { inBlockComment = true; buf += two; i += 2; continue; }
    if (ch === "'") { inSingle = true; buf += ch; i += 1; continue; }

    const dollar = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
    if (dollar) { dollarTag = dollar[0]; buf += dollarTag; i += dollarTag.length; continue; }

    if (ch === ';') { out.push(buf); buf = ''; i += 1; continue; }

    buf += ch;
    i += 1;
  }
  out.push(buf);

  // Drop chunks that are only whitespace/comments (trailing text after the last
  // semicolon, file headers, etc.) — Postgres rejects an empty query string.
  return out
    .map((s) => s.trim())
    .filter((s) => s && stripComments(s).trim().length > 0);
}

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// `-- @requires`: what a file promises to leave behind.
// ---------------------------------------------------------------------------
// Two forms, because two are what the catalog can answer cheaply and
// unambiguously:
//
//   -- @requires table <name>
//   -- @requires column <table>.<name>
//
// Either may be schema-qualified (`table public.served_predictions`,
// `column public.venue_feedback.served_prediction_id`); an unqualified name is
// resolved the way Postgres resolves an unqualified name in the migration's own
// DDL, by walking the whole search_path. A schema-qualified name used to parse
// as a bare table called `public`, which is a requirement nothing can ever
// satisfy.
//
// Identifiers are folded to lower case, exactly as Postgres folds an unquoted
// identifier. `-- @requires table Foo` used to be compared literally against
// pg_class.relname, which holds `foo`, so it could NEVER be satisfied: boot 1
// FATAL, boot 2 FATAL, boot 3 FATAL, forever, from a capital letter in a
// comment. Quoted identifiers are not supported and would be a mistake to
// introduce; nothing in this schema uses them.
//
// A declaration is a line comment that starts at COLUMN 0 and holds nothing but
// the declaration. The old parser was one regex over the raw file text, and it
// matched a `-- @requires` line inside a $$ body, inside a /* */ block comment,
// inside a string literal and indented inside prose. This one is handed only
// the top-level line comments by scanSql.
//
// A line that LOOKS like a declaration but does not parse is a hard startup
// error naming the file and the line, not a line that is quietly never checked.
// That is deliberate and it is the safe direction: a requirement the runner
// cannot evaluate must never be read as evidence that a migration is missing,
// because the heal acts on that evidence. Every file is parsed before the
// runner touches anything, so this fails identically on every boot and cannot
// leave a half-repaired database behind. __tests__/migrationBootSafety.test.js
// parses every file in the directory, so it goes red in CI, not on Railway.
const REQUIRES_RE =
  /^--[ \t]*@requires[ \t]+(table|column)[ \t]+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,2})[ \t]*$/gm;
// Anything that mentions @requires followed by one of the two keywords. Prose
// that talks ABOUT the convention ("the @requires lines below") does not match,
// because `lines` is neither `table` nor `column`.
const REQUIRES_NEARMISS_RE = /^[^\n]*@requires[ \t]+(?:table|column)\b[^\n]*$/gm;

function lineNumberAt(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') n += 1;
  return n;
}

function requirementKey(r) {
  const rel = r.schema ? `${r.schema}.${r.table}` : r.table;
  return r.kind === 'column' ? `column ${rel}.${r.column}` : `table ${rel}`;
}

// `label` is the filename, used only so a parse error can say where.
function parseRequirements(sql, label = 'migration') {
  const { comments } = scanSql(sql);
  const out = [];
  const accepted = new Set();

  REQUIRES_RE.lastIndex = 0;
  let m;
  while ((m = REQUIRES_RE.exec(comments)) !== null) {
    const [line, kind, dotted] = m;
    const parts = dotted.toLowerCase().split('.');
    if (kind === 'column') {
      if (parts.length === 2) out.push({ kind: 'column', schema: null, table: parts[0], column: parts[1] });
      else if (parts.length === 3) out.push({ kind: 'column', schema: parts[0], table: parts[1], column: parts[2] });
      else {
        throw new Error(
          `${label}:${lineNumberAt(comments, m.index)}: \`${line.trim()}\` is not a usable requirement. ` +
          '`@requires column` needs `<table>.<column>` or `<schema>.<table>.<column>`.'
        );
      }
    } else {
      if (parts.length === 1) out.push({ kind: 'table', schema: null, table: parts[0] });
      else if (parts.length === 2) out.push({ kind: 'table', schema: parts[0], table: parts[1] });
      else {
        throw new Error(
          `${label}:${lineNumberAt(comments, m.index)}: \`${line.trim()}\` is not a usable requirement. ` +
          '`@requires table` needs `<name>` or `<schema>.<name>`.'
        );
      }
    }
    accepted.add(m.index);
  }

  // Same scan again, wider, to catch the lines that meant to be declarations
  // and are not. Run over the RAW file, so a declaration hidden in a $$ body or
  // a block comment is reported rather than silently ignored.
  REQUIRES_NEARMISS_RE.lastIndex = 0;
  let n;
  while ((n = REQUIRES_NEARMISS_RE.exec(sql)) !== null) {
    const start = n.index;
    if (accepted.has(start)) continue;
    // The offsets line up because scanSql preserves length, so an accepted
    // declaration has the same index in both strings.
    throw new Error(
      `${label}:${lineNumberAt(sql, start)}: \`${n[0].trim()}\` looks like a post-condition but will not be ` +
      'checked. A declaration must be a line comment starting at column 0, outside any $$ body, block comment ' +
      'or string literal, reading exactly `-- @requires table <name>` or `-- @requires column <table>.<column>`. ' +
      'Fix it or reword the line so it does not read as one.'
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// What a file DROPS, so a stale requirement can be retired instead of fought.
// ---------------------------------------------------------------------------
// Read off the code view, so a DROP inside a $$ body counts and a DROP inside a
// comment or a string literal does not. Deliberately conservative: it
// recognises the two shapes this repo writes: DROP TABLE, optionally IF EXISTS,
// over a comma list; and ALTER TABLE, optionally IF EXISTS and ONLY, carrying a
// DROP COLUMN. Anything it misses only means a requirement stays enforced,
// which is the old behaviour.
//
// Those two are spelled out in prose rather than quoted, and that is not a
// style preference. __tests__/poolQueryGuard.test.js finds the SQL this app
// runs by pulling every backtick-delimited run of text out of the source and
// testing it against the pool's destructive-verb guard, and a markdown quote in
// a COMMENT is indistinguishable from a template literal to that scan. Quoting
// the ALTER shape here therefore published a fake ALTER TABLE ... DROP COLUMN
// out of this file, the guard refused it exactly as it should, and the suite
// went red over a sentence.
function parseDrops(sql) {
  const { code } = scanSql(sql);
  const out = new Set();
  // Schema qualification is dropped on both sides of this comparison: a
  // requirement is matched on its bare relation name, so `DROP TABLE
  // public.foo` retires `-- @requires table foo` and vice versa.
  const bareTable = (raw) => raw.toLowerCase().split('.').pop().trim();

  for (const chunk of code.split(';')) {
    const dropTable = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_.]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_.]*)*)/gi;
    let t;
    while ((t = dropTable.exec(chunk)) !== null) {
      for (const name of t[1].split(',')) out.add(`table ${bareTable(name.trim())}`);
    }

    const alter = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z_][A-Za-z0-9_.]*)/i.exec(chunk);
    if (!alter) continue;
    const table = bareTable(alter[1]);
    const dropCol = /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
    let c;
    while ((c = dropCol.exec(chunk)) !== null) out.add(`column ${table}.${c[1].toLowerCase()}`);
  }
  return out;
}

// A requirement declared by `file` is void once a file sorting AFTER it drops
// that column, or drops the table the column lives on. Returns the surviving
// requirements plus a note for each one that was retired, so startup can say so
// and somebody can delete the dead `@requires` line.
function effectiveRequirements(file, loaded) {
  const reqs = loaded.get(file).reqs;
  if (reqs.length === 0) return { reqs, voided: [] };

  const kept = [];
  const voided = [];
  for (const r of reqs) {
    const key = requirementKey(r);
    const bare = r.kind === 'column' ? `column ${r.table}.${r.column}` : `table ${r.table}`;
    const tableKey = `table ${r.table}`;
    let killer = null;
    for (const [other, info] of loaded) {
      if (other <= file) continue;
      if (info.drops.has(bare) || (r.kind === 'column' && info.drops.has(tableKey))) { killer = other; break; }
    }
    if (killer) voided.push({ key, by: killer });
    else kept.push(r);
  }
  return { reqs: kept, voided };
}

// Returns the requirements that are NOT satisfied, as printable strings. At
// most two catalog SELECTs regardless of how many requirements are passed, and
// none at all when there are none, so the boot-time scan over every applied
// file costs a healthy database one query.
//
// Both queries read pg_class / pg_attribute, which are NOT privilege-filtered.
// The column check used to read information_schema.columns, which IS: under a
// role that is not the table owner and has no grants on it, a perfectly healthy
// database reported three missing columns on venue_feedback, the heal deleted
// 032's row on that evidence, and the re-apply threw 42501 on every boot. Not
// live on Railway, where migrations run as superuser, but the whole point of
// this check is to be right about a database it cannot see.
//
// AN UNQUALIFIED REQUIREMENT IS RESOLVED THE WAY THE MIGRATION'S OWN SQL IS.
// This used to read `n.nspname = COALESCE(w.sch, current_schema())`, and
// current_schema() is only the FIRST entry of search_path: it is where a new
// unqualified object gets CREATED, not where an existing one is FOUND. Postgres
// finds an existing relation by walking every entry. So with
// `search_path=migrations,public` and the Flock tables in public, `ALTER TABLE
// venue_feedback ADD COLUMN ...` inside the migration reached
// public.venue_feedback and so did every query the application makes, while
// this verifier looked only in `migrations`, found nothing, and reported the
// columns missing on a database where they were present and in use. What that
// costs is not a warning: assertRequirementsMet throws, the file rolls back,
// migrate() rejects, and server.js exits 1 before it ever listens, on every
// boot, over a schema that was correct the whole time. The heal has the same
// evidence and re-applies every already-applied file each boot before giving up
// and declaring the service degraded.
//
// pg_table_is_visible(oid) IS that walk, and it is the same function psql's \d
// and regclass casts use, so the verifier and the DDL now agree by
// construction. A qualified requirement still means exactly the schema it
// names, which is what to write when a name is ambiguous across the path.
async function findMissingRequirements(client, reqs) {
  const missing = [];

  const columns = new Map();
  const tables = new Map();
  for (const r of reqs) {
    if (r.kind === 'column') columns.set(requirementKey(r), r);
    else tables.set(requirementKey(r), r);
  }

  if (columns.size > 0) {
    const want = [...columns.values()];
    const { rows } = await client.query(
      `SELECT w.ord
         FROM unnest($1::text[], $2::text[], $3::text[])
              WITH ORDINALITY AS w(sch, rel, col, ord)
         JOIN pg_class c ON c.relname = w.rel
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a
           ON a.attrelid = c.oid AND a.attname = w.col
          AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind = ANY($4::"char"[])
          AND CASE WHEN w.sch IS NULL
                   THEN pg_catalog.pg_table_is_visible(c.oid)
                   ELSE n.nspname = w.sch
              END`,
      [
        want.map((r) => r.schema),
        want.map((r) => r.table),
        want.map((r) => r.column),
        REQUIRABLE_RELKINDS,
      ]
    );
    const have = new Set(rows.map((r) => Number(r.ord)));
    want.forEach((r, idx) => { if (!have.has(idx + 1)) missing.push(requirementKey(r)); });
  }

  if (tables.size > 0) {
    const want = [...tables.values()];
    const { rows } = await client.query(
      `SELECT w.ord
         FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS w(sch, rel, ord)
         JOIN pg_class c ON c.relname = w.rel
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = ANY($3::"char"[])
          AND CASE WHEN w.sch IS NULL
                   THEN pg_catalog.pg_table_is_visible(c.oid)
                   ELSE n.nspname = w.sch
              END`,
      [want.map((r) => r.schema), want.map((r) => r.table), REQUIRABLE_RELKINDS]
    );
    const have = new Set(rows.map((r) => Number(r.ord)));
    want.forEach((r, idx) => { if (!have.has(idx + 1)) missing.push(requirementKey(r)); });
  }

  return missing;
}

// Run after the file's statements, before schema_migrations is written. In the
// default mode this executes inside the file's own open transaction, so it sees
// the uncommitted DDL and a throw rolls the whole thing back.
async function assertRequirementsMet(client, file, reqs) {
  if (reqs.length === 0) return;
  const missing = await findMissingRequirements(client, reqs);
  if (missing.length > 0) {
    throw new Error(
      `${file} ran without raising, but ${missing.join(', ')} still missing. ` +
      'A statement was skipped or its error was swallowed; refusing to record this migration as applied.'
    );
  }
}

function migrationMode(sql) {
  const head = sql.trimStart();
  if (head.startsWith('-- @tolerant')) return 'tolerant';
  if (head.startsWith('-- @noTransaction')) return 'noTransaction';
  return 'transaction';
}

// Read and parse every file once, before anything runs. A parse error here is
// fatal and happens before the runner has touched a single row.
function loadMigrations(dir, files) {
  const loaded = new Map();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    loaded.set(file, {
      sql,
      mode: migrationMode(sql),
      reqs: parseRequirements(sql, file),
      drops: parseDrops(sql),
    });
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// The self-heal.
// ---------------------------------------------------------------------------
// A database marked as having 032/038 while the columns never landed has no
// other way back: nothing re-runs a migration the runner believes is done. So
// before the normal loop, re-check the declared post-conditions of every file
// already in schema_migrations and re-apply the ones that do not hold.
//
// The row stays put throughout. A successful repair refreshes applied_at; a
// failed one changes nothing at all, logs, and lets the boot continue degraded.
// See the header for what deleting the row first cost.
async function healFalselyAppliedMigrations(client, loaded, applied) {
  const byFile = new Map();
  const all = [];
  for (const [file, info] of loaded) {
    if (!applied.has(file)) continue;
    const { reqs } = effectiveRequirements(file, loaded);
    if (reqs.length === 0) continue;
    byFile.set(file, reqs);
    all.push(...reqs);
  }
  if (all.length === 0) return;

  const missing = new Set(await findMissingRequirements(client, all));
  if (missing.size === 0) return;

  let repaired = 0;
  const failed = [];
  for (const [file, reqs] of byFile) {
    const gone = reqs.map(requirementKey).filter((s) => missing.has(s));
    if (gone.length === 0) continue;
    console.error(
      `[migrate] ${file} is recorded as applied but ${gone.join(', ')} is missing. ` +
      're-applying it (its error was swallowed on a previous boot)'
    );
    try {
      await reapplyMigration(client, file, loaded.get(file), reqs);
      repaired += 1;
      console.log(`[migrate] repaired ${file}`);
    } catch (e) {
      failed.push(file);
      await client.query('ROLLBACK').catch(() => {});
      console.error(
        `[migrate] could not repair ${file}: ${e.message}. Nothing was changed: schema_migrations still ` +
        `records it and ${gone.join(', ')} is still missing. The service will start DEGRADED, which is the ` +
        'state it was already in, and the next boot will try again.'
      );
    }
  }
  if (failed.length > 0) {
    console.error(
      `[migrate] BOOTING DEGRADED: ${failed.join(', ')} could not be repaired` +
      (repaired > 0 ? `, ${repaired} other file(s) were` : '') +
      '. Anything reading the missing columns will fail until the next boot repairs them.'
    );
  }
}

// Re-run a file that is ALREADY recorded as applied. Never touches the row on
// the way in, and only ever writes it on success, so a throw from here leaves
// schema_migrations exactly as it found it.
async function reapplyMigration(client, file, info, reqs) {
  if (info.mode === 'transaction') {
    try {
      await client.query('BEGIN');
      await client.query(info.sql);
      await assertRequirementsMet(client, file, reqs);
      await client.query('UPDATE schema_migrations SET applied_at = NOW() WHERE name = $1', [file]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
    return;
  }

  // tolerant and noTransaction both autocommit per statement, so there is no
  // transaction to roll back and never was. The row is still safe, because it
  // is only written after the requirements are re-checked and only ever with an
  // UPDATE of applied_at, so a failure leaves the row and the schema alone.
  for (const stmt of splitStatements(info.sql)) {
    try {
      await client.query(stmt);
    } catch (e) {
      if (info.mode === 'noTransaction') throw e;
      console.warn(`[migrate] ${file} tolerant skip: ${e.message}`);
    }
  }
  await assertRequirementsMet(client, file, reqs);
  await client.query('UPDATE schema_migrations SET applied_at = NOW() WHERE name = $1', [file]);
}

async function runMigrations(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ DEFAULT NOW()
     )`
  );

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const loaded = loadMigrations(dir, files);

  for (const file of files) {
    for (const v of effectiveRequirements(file, loaded).voided) {
      console.warn(
        `[migrate] ${file} declares \`${v.key}\` but ${v.by} drops it. The post-condition is being ignored, ` +
        'not enforced, so the drop stands. Delete that @requires line from the source.'
      );
    }
  }

  const appliedRes = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map((r) => r.name));

  await healFalselyAppliedMigrations(client, loaded, applied);

  for (const file of files) {
    if (applied.has(file)) continue;
    const info = loaded.get(file);
    const sql = info.sql;
    const reqs = effectiveRequirements(file, loaded).reqs;
    const mode = info.mode === 'tolerant' ? ' (tolerant)' : info.mode === 'noTransaction' ? ' (no transaction)' : '';
    console.log(`[migrate] applying ${file}${mode}`);

    if (info.mode === 'tolerant') {
      const stmts = splitStatements(sql);
      let failures = 0;
      for (const stmt of stmts) {
        try {
          await client.query(stmt);
        } catch (e) {
          failures += 1;
          console.warn(`[migrate] ${file} tolerant skip: ${e.message}`);
        }
      }
      const unmet = failures === 0 ? await findMissingRequirements(client, reqs) : [];
      if (failures === 0 && unmet.length === 0) {
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      } else if (unmet.length > 0) {
        console.error(
          `[migrate] ${file}: every statement returned but ${unmet.join(', ')} is missing. ` +
          'NOT recording as applied, will retry next boot'
        );
      } else {
        // A transient error (lock, dependency, drift) must not permanently
        // skip DDL: leave the file pending so the next boot replays it. The
        // statements are idempotent, so replay is safe and cheap.
        console.error(`[migrate] ${file}: ${failures} statement(s) failed — NOT recording as applied, will retry next boot`);
      }
    } else if (info.mode === 'noTransaction') {
      // Each statement autocommits. There is no rollback, so every statement in
      // such a file must be independently idempotent; the first failure still
      // halts the boot rather than recording a half-applied file.
      for (const stmt of splitStatements(sql)) {
        try {
          await client.query(stmt);
        } catch (e) {
          console.error(`[migrate] FAILED ${file}: ${e.message}`);
          throw e;
        }
      }
      await assertRequirementsMet(client, file, reqs);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    } else {
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await assertRequirementsMet(client, file, reqs);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[migrate] FAILED ${file}: ${e.message}`);
        throw e; // boot must not continue on a half-applied schema
      }
    }
    console.log(`[migrate] applied ${file}`);
  }
}

module.exports = {
  migrate,
  splitStatements,
  parseRequirements,
  parseDrops,
  findMissingRequirements,
  requirementKey,
};

// ---------------------------------------------------------------------------
// RUNNING THIS FILE DIRECTLY. `node db/migrate.js`.
// ---------------------------------------------------------------------------
// Until 2026-08-26 this block did not exist, and the consequence was not a
// missing convenience. It was a restore procedure that quietly did nothing.
//
// `node db/migrate.js` is step 4 of the restore drill in
// BACKUP-AND-VERIFICATION.md and the middle line of the three-line restore in
// scripts/encrypt-backup.md. Without an entry point, running it defined some
// functions, exported them, and exited 0. No output, no error, no migrations.
// An operator following the written procedure got the thirteen bootstrap tables
// from schema.sql and none of the fifty-two files after it, then loaded the
// dump on top and watched it die on the first table migration 001 introduced.
// Measured, not theorised: `DATABASE_URL=postgresql://nonexistent:1/x node
// db/migrate.js` returned 0 in well under a second, having never opened a
// socket.
//
// That failure is loud, because the restore step runs psql with
// ON_ERROR_STOP=1. It is still the worst possible time to find out, since by
// then the database exists, the dump is decrypted on disk, and the person
// reading the error has no reason to suspect the step that printed nothing.
//
// Exit codes are the contract here: 0 only when every pending file applied, 1
// on any failure, so a script can chain on it the way server.js depends on the
// promise rejecting.
if (require.main === module) {
  const pool = require('../config/database');
  migrate(pool)
    .then(() => {
      console.log('[migrate] all migrations are applied');
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[migrate] FATAL: ${err.message}`);
      console.error('The database was NOT left half-migrated: the failing file rolled back.');
      console.error('Fix the migration and run this again. Do not hand-insert a schema_migrations row.');
      pool.end().catch(() => {}).finally(() => process.exit(1));
    });
}
