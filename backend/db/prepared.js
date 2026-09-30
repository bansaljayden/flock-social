// NAMED STATEMENTS FOR THE HOTTEST FIXED QUERIES.
//
// node-postgres sends a query with values as an UNNAMED statement, and Postgres
// parses and plans an unnamed statement from scratch every time. For the short
// lookups every screen makes, the planning is most of the cost: measured on the
// local stack (2026-09-29, log_min_duration_statement = 0), the auth check's
// user row took 0.20 ms to parse and plan and 0.02 ms to run, and opening one
// flock spent 2.8 ms planning against 0.16 ms of execution across its eight
// statements. A named statement is parsed once per pooled connection, and
// after five runs Postgres settles on a generic plan when that plan is no
// worse than the custom ones.
//
// A call site opts in by wrapping its SQL: `pool.query(prepared('auth-user',
// SQL), [id])`. The text comes back unchanged, so a test that swaps out
// pool.query sees the same string it always did; config/database.js is what
// turns a registered text into `{ name, text, values }` on the real pool. A
// client checked out with pool.connect() does not go through that wrapper and
// stays unnamed, which keeps transactions exactly as they were.
//
// ONLY STATEMENTS WHOSE PLAN DOES NOT TURN ON A PARAMETER'S VALUE. A primary
// key or a foreign key equality plans the same for every id. The chat history
// read (`$2::int IS NULL OR m.id < $2`) is left unnamed on purpose: a generic
// plan cannot drop the branch a custom plan drops, and a cheap-looking generic
// plan there could be a slow one.
//
// THE CATCH IS A SELECT *. A migration that adds a column changes the result
// row of `f.*`, and Postgres refuses every later run of the already-prepared
// statement with 0A000 ("cached plan must not change result type"). Migrations
// run on the NEW server at boot while the OLD one is still serving, so the old
// one would fail that read until it was retired. On that error the wrapper
// answers the same call unnamed and retires the text for the rest of this
// process; the next process prepares against the migrated schema.

const nameByText = new Map();
const textByName = new Map();
const retired = new Set();

/**
 * Register `text` as the named statement `name` and hand the text back.
 * A name is one statement per process: node-postgres refuses a second text
 * under a name a connection has already prepared, so a clash throws here, at
 * the first call, instead of on some later connection.
 */
function prepared(name, text) {
  const known = textByName.get(name);
  if (known === undefined) {
    textByName.set(name, text);
    nameByText.set(text, name);
  } else if (known !== text) {
    throw new Error(`prepared statement "${name}" is already registered with a different text`);
  }
  return text;
}

/** The statement name for `text`, or null when it is not registered or was retired. */
function preparedName(text) {
  if (typeof text !== 'string' || retired.has(text)) return null;
  return nameByText.get(text) || null;
}

/** Stop naming `text` in this process (its result row changed under it). */
function retirePrepared(text) {
  retired.add(text);
}

module.exports = { prepared, preparedName, retirePrepared };
