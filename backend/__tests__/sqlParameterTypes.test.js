'use strict';
// ---------------------------------------------------------------------------
// LET POSTGRES JUDGE EVERY STATEMENT THIS APP SENDS IT.
//
// THE DEFECT THIS EXISTS FOR
// routes/guest.js updated a guest's RSVP with $2 assigned bare into a
// VARCHAR(10) column and compared as $2::text in the same statement. Postgres
// cannot settle on one type for a parameter used both ways and refuses the
// whole statement, 42P08, "inconsistent types deduced for parameter $2". The
// route's catch turned that into a 500 on the ONLY path a returning guest has,
// so a guest could answer a share link once and then never change their mind,
// rename, or come back. The first answer goes down a different path, an INSERT
// with no cast in it, which is why the flow looked like it worked.
//
// Nothing caught it. It is valid JavaScript, valid-looking SQL, and every unit
// test around that route asserts on shapes and helpers rather than executing
// the statement. It was found by a browser walking the guest link, days later.
//
// WHAT THIS DOES
// Pulls every static SQL string out of the app, applies the real migrations to
// a real Postgres, and PREPAREs each one. Preparing is exactly the step that
// deduces parameter types, and it touches no data.
//
// WHAT IT FAILS ON
// Every refusal. A statement Postgres will not prepare is a statement it will
// not run with any input at all, so the failure is real whatever the code says:
// this sweep was written for one ambiguous parameter and immediately found two
// more of those and a GREATEST asked to match a timestamp against an interval,
// which had been failing into a catch that only logged.
//
// A statement that is genuinely fine and only refuses out of context goes in
// PREPARE_EXEMPT by name, with the reason. That list is empty and the intent is
// that it stays that way: an entry is somebody promising they read one.
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

const PG_PORT = pickEmbeddedPgPort('sqlParameterTypes');
const ROOT = path.join(__dirname, '..');

// Where the app's own statements live. Tests and scripts are out: a fixture is
// allowed to be strange, and scripts/ml runs against a corpus this schema does
// not carry.
const DIRS = ['routes', 'services', 'sockets', 'utils', 'db', 'middleware', 'config'];

/* Statements Postgres genuinely cannot prepare out of context go here BY
   NAME, each with its reason. It is empty, and it should stay that way: the
   point of this suite is that the database is the judge, and an entry here
   is a promise that a person read one and found the refusal to be about the
   context rather than the statement. */
const PREPARE_EXEMPT = new Map();

// The code Postgres uses for a parameter it cannot give one type to. Named
// because the proof at the bottom of this file watches for exactly it.
const AMBIGUOUS_PARAMETER = '42P08';

let pg;
let pool;
let dataDir;

/** Every .js file under the directories above. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  for (const d of DIRS) walk(path.join(ROOT, d));
  return out;
}

/**
 * Every template literal in a file that looks like one whole SQL statement.
 *
 * Interpolated ones are skipped rather than guessed at: a `${}` is a hole this
 * file cannot fill, and filling it with something invented would test a
 * statement the app never sends. That is a real limit and it is written into
 * the count the last test asserts, so the skip cannot quietly grow to cover
 * everything.
 */
function statementsIn(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  /* Whole comment LINES go first, and only whole ones. Several files quote
     real SQL inside prose (routes/admin.js quotes the grant server.js runs,
     utils/placesBudget.js quotes a ledger it recommends), and neither is a
     statement anybody sends. Blanking rather than deleting keeps every line
     number honest, and matching only at the start of a line means a `//`
     inside a real string is left alone. */
  const text = raw.split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    .join('\n');
  const found = [];
  const re = /`([^`]*)`/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    if (body.includes('${')) continue;
    const sql = body.trim();
    if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) continue;
    // One statement per PREPARE. A string holding two is a fixture, not a call.
    if (sql.replace(/;\s*$/, '').includes(';')) continue;
    if (!/\$\d/.test(sql)) continue;   // no parameters, nothing to deduce
    found.push({
      file: path.relative(ROOT, file).replace(/\\/g, '/'),
      line: text.slice(0, m.index).split('\n').length,
      sql: sql.replace(/;\s*$/, ''),
    });
  }
  return found;
}

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-sqlparams-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'sqlParameterTypes', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_sqlparams_test');
  pool = new Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_sqlparams_test`,
  });
  const { migrate } = require('../db/migrate');
  await migrate(pool);
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('every statement the app sends is one Postgres will accept', async () => {
  const statements = sourceFiles().flatMap(statementsIn);
  // A sweep that finds nothing to sweep passes for the wrong reason.
  assert.ok(statements.length > 80,
    `expected the app to carry plenty of parameterised SQL, found ${statements.length}`);

  const refused = [];
  const otherwiseDeclined = [];
  let n = 0;
  for (const s of statements) {
    n += 1;
    const name = `sqlparams_${n}`;
    try {
      await pool.query(`PREPARE ${name} AS ${s.sql}`);
      await pool.query(`DEALLOCATE ${name}`);
    } catch (err) {
      const where = `${s.file}:${s.line}`;
      if (PREPARE_EXEMPT.has(where)) otherwiseDeclined.push(`${where}  exempt: ${PREPARE_EXEMPT.get(where)}`);
      else refused.push(`${where}  [${err.code}] ${err.message}`);
    }
  }

  if (otherwiseDeclined.length) {
    // Information, not a verdict. See the header for why these do not fail.
    console.log(
      `\n  ${otherwiseDeclined.length} statement(s) Postgres would not prepare out of context:\n    `
      + otherwiseDeclined.join('\n    ') + '\n'
    );
  }

  assert.deepStrictEqual(
    refused, [],
    'Postgres will not prepare these, which means it will not run them with any '
    + 'input at all. The commonest cause is one parameter used both bare and with '
    + 'an explicit cast, which leaves it with two deduced types: cast it the same '
    + 'way in every position. If a statement is genuinely fine and only refuses out '
    + 'of context, add it to PREPARE_EXEMPT with the reason.\n  ' + refused.join('\n  ')
  );
});

test('the statement that taught us this is in the set, and prepares', async () => {
  /* Named rather than counted. The guest RSVP update is the one this suite was
     written for, and a sweep that silently stopped reaching it would pass. */
  const guest = statementsIn(path.join(ROOT, 'routes', 'guest.js'))
    .filter((s) => /UPDATE guest_rsvps SET name/.test(s.sql));
  assert.strictEqual(guest.length, 1, 'the guest RSVP update should be picked up exactly once');
  await pool.query(`PREPARE sqlparams_guest AS ${guest[0].sql}`);
  await pool.query('DEALLOCATE sqlparams_guest');
});

test('the shape it had when it was broken is still refused by this database', async () => {
  /* Proof the check can fail, run against the same Postgres the check uses. If
     a future version of Postgres started accepting this, the test above would
     be watching for something that cannot happen, and this goes red first. */
  const asShipped = `UPDATE guest_rsvps SET name = $1, status = $2, updated_at = NOW(),
       reconfirmed_at = CASE WHEN $2::text = 'in' AND status = 'in' THEN reconfirmed_at ELSE NULL END
     WHERE guest_token = $3 AND flock_id = $4 AND COALESCE(is_hidden, false) = false
     RETURNING id, guest_token`;
  await assert.rejects(
    () => pool.query(`PREPARE sqlparams_broken AS ${asShipped}`),
    (err) => err.code === AMBIGUOUS_PARAMETER
  );
});
