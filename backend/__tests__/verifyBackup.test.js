// Pins the dump-format contract between scripts/dump-db.js and
// scripts/verify-backup.js: the manifest comment shape and the statement
// reassembly that verify-backup uses to replay a dump with ON_ERROR_STOP
// semantics. The parser only has to be right about what dump-db.js emits —
// single-quoted literals with '' escaping (which may span lines), line
// comments at statement boundaries, statements ending with `;` at end of
// line — but being wrong about any of it silently mis-splits a restore, so
// the hostile cases live here. The full restore-and-check path is exercised
// for real by running the script against a fixture dump (see
// BACKUP-AND-VERIFICATION.md); embedded Postgres is deliberately kept out of
// the unit suite to keep `npm test` fast.
const { test } = require('node:test');
const assert = require('node:assert');

const { parseManifestLine, StatementAssembler } = require('../scripts/verify-backup');

// --------------------------------------------------------------------------
// Manifest comments: `-- users (12)` is a manifest entry, everything else a
// dump emits as a comment is not.
// --------------------------------------------------------------------------
test('parseManifestLine reads the row-count manifest dump-db.js writes', () => {
  assert.deepStrictEqual(parseManifestLine('-- users (12)'), { table: 'users', count: 12 });
  assert.deepStrictEqual(parseManifestLine('-- ml_training_data (3993762)'),
    { table: 'ml_training_data', count: 3993762 });
  assert.deepStrictEqual(parseManifestLine('-- flock_members (0)'), { table: 'flock_members', count: 0 });
});

test('parseManifestLine ignores the other comments a dump contains', () => {
  assert.strictEqual(parseManifestLine('-- Flock data dump 2026-08-14T16:39:21.626Z'), null);
  assert.strictEqual(parseManifestLine('-- Restore: create structure from database/schema.sql + migrations, then run this file.'), null);
  assert.strictEqual(parseManifestLine('-- sequences'), null);
  assert.strictEqual(parseManifestLine('-- users (twelve)'), null);
  assert.strictEqual(parseManifestLine('INSERT INTO "users" (...) VALUES'), null);
  // Only a comment at column 0 is a manifest line; this text inside a literal
  // is handled by the assembler, but the parser must not match it either.
  assert.strictEqual(parseManifestLine('  -- users (12)'), null);
});

// --------------------------------------------------------------------------
// Statement reassembly.
// --------------------------------------------------------------------------
function assemble(text) {
  const comments = [];
  const asm = new StatementAssembler((c) => comments.push(c));
  const statements = [];
  for (const line of text.split('\n')) {
    const s = asm.push(line);
    if (s) statements.push(s);
  }
  return { statements, comments, dangling: asm.dangling() };
}

test('splits simple statements and routes boundary comments aside', () => {
  const { statements, comments, dangling } = assemble([
    '-- Flock data dump 2026-08-14T00:00:00.000Z',
    'BEGIN;',
    'SET session_replication_role = replica;',
    '',
    '-- users (1)',
    `INSERT INTO "users" ("id", "email") VALUES`,
    `  (1, 'a@fix.test')`,
    'ON CONFLICT DO NOTHING;',
    '',
    'COMMIT;',
  ].join('\n'));
  assert.strictEqual(statements.length, 4); // BEGIN, SET, INSERT, COMMIT
  assert.match(statements[2], /^INSERT INTO "users"/);
  assert.match(statements[2], /ON CONFLICT DO NOTHING;$/);
  assert.deepStrictEqual(comments, [
    '-- Flock data dump 2026-08-14T00:00:00.000Z',
    '-- users (1)',
  ]);
  assert.strictEqual(dangling, false);
});

test('a literal containing semicolons, fake comments, and COMMIT; cannot end a statement', () => {
  // This is real fixture content: a chat message is arbitrary text.
  const { statements, dangling } = assemble([
    `INSERT INTO "messages" ("id", "message_text") VALUES`,
    `  (1, 'multi`,
    `line; with ''quotes'' and -- fake comment`,
    `COMMIT;`,
    `end of message');`,
    `COMMIT;`,
  ].join('\n'));
  assert.strictEqual(statements.length, 2);
  assert.match(statements[0], /end of message'\);$/);
  // The literal's newlines survive intact — they are data, not formatting.
  assert.ok(statements[0].includes("line; with ''quotes'' and -- fake comment\nCOMMIT;"));
  assert.strictEqual(statements[1], 'COMMIT;');
  assert.strictEqual(dangling, false);
});

test("'' escaped quotes do not flip the literal state", () => {
  const { statements } = assemble([
    `INSERT INTO "flocks" ("name") VALUES ('Saturday; DROP TABLE users; --');`,
    `INSERT INTO "flocks" ("name") VALUES ('it''s; still ''one'' literal');`,
  ].join('\n'));
  assert.strictEqual(statements.length, 2);
  assert.match(statements[0], /DROP TABLE users; --'\);$/);
  assert.match(statements[1], /one'' literal'\);$/);
});

test('a truncated file is reported as dangling, never as a completed statement', () => {
  // Cut mid-row: the assembler must hold the fragment, not emit it.
  const midRow = assemble([
    `INSERT INTO "ml_training_data" ("id", "venue_id") VALUES`,
    `  (743, 2`,
  ].join('\n'));
  assert.strictEqual(midRow.statements.length, 0);
  assert.strictEqual(midRow.dangling, true);

  // Cut mid-literal: an open quote swallows everything after it, including a
  // line that ends with `;` — the statement must still be dangling.
  const midLiteral = assemble([
    `INSERT INTO "messages" ("message_text") VALUES ('an open literal`,
    `that never closes;`,
  ].join('\n'));
  assert.strictEqual(midLiteral.statements.length, 0);
  assert.strictEqual(midLiteral.dangling, true);
});

test('CRLF is stripped outside literals only', () => {
  const asm = new StatementAssembler();
  // Outside a literal the \r is a transfer artifact and must go.
  const s1 = asm.push("INSERT INTO \"users\" (\"id\") VALUES (1);\r");
  assert.strictEqual(s1, 'INSERT INTO "users" ("id") VALUES (1);');
  // Inside a literal a trailing \r is data and must survive.
  assert.strictEqual(asm.push("INSERT INTO \"messages\" (\"t\") VALUES ('line one\r"), null);
  const s2 = asm.push("line two');");
  assert.ok(s2.includes('line one\r\nline two'));
});

test('setval lines parse as ordinary statements', () => {
  const { statements, comments } = assemble([
    '-- sequences',
    `SELECT setval('"users_id_seq"', 3, true);`,
    `SELECT setval('"flocks_id_seq"', 2, false);`,
  ].join('\n'));
  assert.strictEqual(statements.length, 2);
  assert.deepStrictEqual(comments, ['-- sequences']);
});
