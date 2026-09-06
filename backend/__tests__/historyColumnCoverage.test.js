// ---------------------------------------------------------------------------
// THE HISTORY READS NAME THEIR COLUMNS, SO SOMETHING HAS TO WATCH THE LIST.
// ---------------------------------------------------------------------------
// Both chat history queries used to `SELECT m.*` / `SELECT dm.*` and then
// override image_url with a CASE. The star already carried image_url, so
// Postgres detoasted and transmitted the full base64 image for every row and
// node-postgres discarded it (last duplicate field name wins). That is roughly
// 12 MB of read, pool transfer and heap for a page of fifteen photos, to
// deliver about 1.4 MB of thumbnails.
//
// Naming the columns is the only way to not select one, and it introduces the
// hazard this file exists to close: a migration adds a column, nobody updates
// the query, and the field silently stops reaching the client. A missing
// `system_kind` renders a system row as blank; a missing `delivered_at` breaks
// receipts. Both would pass every other test in this suite, because a column
// that is absent from the SELECT is simply `undefined` in JS.
//
// So the column set is derived from the SAME source the database is built
// from - schema.sql plus every migration - and compared against what the
// queries actually list. It needs no database and no fixtures.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'routes', 'messages.js'), 'utf8');

/** Every column of `table`, from the base schema plus later ADD COLUMNs. */
function columnsOf(table) {
  const cols = new Set();

  const schema = fs.readFileSync(path.join(ROOT, 'database', 'schema.sql'), 'utf8');
  // The CREATE TABLE body, up to the line that closes it.
  const create = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i',
  ).exec(schema);
  assert.ok(create, `${table} has a CREATE TABLE in schema.sql`);
  for (const line of create[1].split('\n')) {
    // A column definition starts with an identifier. Table constraints start
    // with a keyword, so those are skipped rather than mistaken for columns.
    const m = /^\s{2,}([a-z_][a-z0-9_]*)\s+/i.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (['primary', 'foreign', 'unique', 'check', 'constraint'].includes(name)) continue;
    cols.add(name);
  }

  // ADD COLUMN across every migration, whatever order they ran in.
  const migDir = path.join(ROOT, 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    const re = new RegExp(
      `ALTER TABLE\\s+${table}\\s+([\\s\\S]*?);`, 'gi',
    );
    let m;
    while ((m = re.exec(sql)) !== null) {
      const add = /ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi;
      let a;
      while ((a = add.exec(m[1])) !== null) cols.add(a[1].toLowerCase());
    }
  }
  return cols;
}

/** The columns a query lists for the given alias, plus anything it aliases AS. */
function selectedFor(sql, alias) {
  const named = new Set();
  const re = new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'gi');
  let m;
  while ((m = re.exec(sql)) !== null) named.add(m[1].toLowerCase());
  return named;
}

/** The SELECT list of the query assigned to `name`, up to its FROM.
 *
 *  SQL LINE COMMENTS ARE STRIPPED FIRST, and that is not tidiness. These
 *  queries are heavily commented, and a comment that names a column would let
 *  the coverage check below pass on prose instead of on a real SELECT - the
 *  exact way a test like this goes green on nothing. It also stopped the star
 *  check from matching the sentence explaining why the star was removed. */
function selectListOf(varName) {
  const at = SRC.indexOf(`const ${varName} = \``);
  assert.ok(at > -1, `${varName} exists in routes/messages.js`);
  const body = SRC.slice(at, SRC.indexOf('`;', at))
    // [^\r\n] rather than `.` with a `$` anchor: this repo's files are CRLF,
    // JS's `.` does not match \r, and `$` without the m flag only matches the
    // very end of input - so `--.*$` silently stripped nothing at all here.
    .replace(/--[^\r\n]*/g, '');
  const from = body.search(/\n\s*FROM\s/i);
  assert.ok(from > -1, `${varName} has a FROM`);
  return body.slice(0, from);
}

for (const [varName, alias, table] of [
  ['messagesQuery', 'm', 'messages'],
  ['dmQuery', 'dm', 'direct_messages'],
]) {
  test(`${table} history returns every column the table has`, () => {
    const list = selectListOf(varName);

    // The star is what this whole change removed. If it comes back, the
    // detoast comes back with it and this file is pointless.
    assert.ok(!new RegExp(`\\b${alias}\\.\\*`).test(list),
      `${varName} must name its columns; ${alias}.* re-reads the full image blob for every row`);

    const have = selectedFor(list, alias);
    const want = columnsOf(table);

    // image_url is deliberately absent from the plain list: it arrives only
    // through the CASE that swaps it for NULL when a thumbnail exists, which
    // is the entire point.
    assert.ok(new RegExp(`CASE WHEN ${alias}\\.thumb_url IS NOT NULL THEN NULL ELSE ${alias}\\.image_url END AS image_url`).test(list),
      `${varName} still ships the thumbnail instead of the full image`);

    const missing = [...want].filter((c) => !have.has(c)).sort();
    assert.deepStrictEqual(missing, [],
      `these ${table} columns exist but ${varName} does not return them - a migration `
      + 'added a column and the history read was not updated, so the field is undefined '
      + 'on every row the client receives');
  });
}

test('the column lists were derived from something real, not an empty set', () => {
  // A regex that quietly matched nothing would make every assertion above
  // vacuous, which is the classic way a test like this goes green on nothing.
  assert.ok(columnsOf('messages').size >= 10, 'messages columns were parsed');
  assert.ok(columnsOf('direct_messages').size >= 12, 'direct_messages columns were parsed');
  assert.ok(columnsOf('messages').has('system_kind'),
    'a column added by a late migration is picked up, not just the base schema');
  assert.ok(columnsOf('direct_messages').has('delivered_at'),
    'the same, on the DM side');
});
