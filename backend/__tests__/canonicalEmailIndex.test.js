// Run: node --test __tests__/canonicalEmailIndex.test.js  (from backend/)
//
// Migration 062 turns the canonical-email check in routes/auth.js into a
// unique index. The two are one alphabet or they are a disagreement about who
// owns a mailbox: an index over a different expression would let a row in
// that the check refuses, or refuse one the check allows. So the expression
// in the migration is pinned equal to EMAIL_CANONICAL_SQL, whitespace aside.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'canonical-index-pin';
const { EMAIL_CANONICAL_SQL } = require('../routes/auth');

const norm = (s) => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

test('migration 062 indexes exactly the expression findUserByEmail compares in', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '062_users_canonical_email_unique.sql'), 'utf8');
  const m = sql.match(/CREATE UNIQUE INDEX IF NOT EXISTS uq_users_canonical_email ON users \(\(([\s\S]*?)\)\);/);
  assert.ok(m, 'the migration no longer creates uq_users_canonical_email over an expression');
  const indexExpr = norm(m[1]);
  const routeExpr = norm(EMAIL_CANONICAL_SQL.replace(/^\(/, '').replace(/\)$/, ''));
  assert.strictEqual(indexExpr, routeExpr);
});

test('the expression is immutable enough to index: no volatile function, no parameter', () => {
  assert.ok(!/\$\d/.test(EMAIL_CANONICAL_SQL), 'a parameter cannot be indexed');
  assert.ok(!/now\(|random\(|current_/i.test(EMAIL_CANONICAL_SQL));
});
