// Run: node --test  (from backend/)
//
// REGISTERED HOT STATEMENTS GO OUT NAMED, AND FALL BACK WHEN A MIGRATION
// CHANGES THEIR RESULT ROW.
//
// db/prepared.js registers a statement's text under a name; config/database.js
// turns a registered (text, values) call on the real pool into
// { name, text, values }. Pinned here, against the pool wrapper itself (the
// pg-pool query underneath is replaced before the pool module loads):
//   1. Registered text goes out named with the same text and values; every
//      other call reaches pg exactly as it was made.
//   2. A name is one text: a second text under it throws at registration.
//   3. On 0A000 the same call answers unnamed, and later calls skip the name.
//   4. Any other database error still rejects, once, and the name stays.

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

let sent = [];
let namedFailure = null;
Pool.prototype.query = function fakeQuery(...args) {
  sent.push(args);
  const named = args[0] && typeof args[0] === 'object';
  if (named && namedFailure) return Promise.reject(namedFailure);
  const cb = args.find((a) => typeof a === 'function');
  if (cb) { cb(null, { rows: [] }); return undefined; }
  return Promise.resolve({ rows: [{ ok: true }], rowCount: 1 });
};

const pool = require('../config/database');
const { prepared, preparedName } = require('../db/prepared');

const HOT = prepared('test-hot', 'SELECT id, name FROM users WHERE id = $1');

test('prepared hands the text back and a name holds one text', () => {
  assert.strictEqual(HOT, 'SELECT id, name FROM users WHERE id = $1');
  assert.strictEqual(prepared('test-hot', HOT), HOT, 'the same pair again is fine');
  assert.throws(() => prepared('test-hot', 'SELECT 1 WHERE $1 = 1'), /already registered/);
  assert.strictEqual(preparedName(HOT), 'test-hot');
  assert.strictEqual(preparedName('SELECT 2'), null);
});

test('a registered text goes out named with the same text and values', async () => {
  sent = [];
  const r = await pool.query(HOT, [7]);
  assert.deepStrictEqual(r.rows, [{ ok: true }]);
  assert.deepStrictEqual(sent, [[{ name: 'test-hot', text: HOT, values: [7] }]]);
});

test('every other call form reaches pg as it was made', async () => {
  sent = [];
  await pool.query('SELECT id FROM users WHERE id = $1', [7]);
  await pool.query('SELECT NOW()');
  await pool.query({ name: 'own-name', text: 'SELECT $1::int', values: [1] });
  await new Promise((resolve) => pool.query(HOT, [8], resolve));
  assert.deepStrictEqual(sent[0], ['SELECT id FROM users WHERE id = $1', [7]]);
  assert.deepStrictEqual(sent[1], ['SELECT NOW()']);
  assert.deepStrictEqual(sent[2], [{ name: 'own-name', text: 'SELECT $1::int', values: [1] }]);
  assert.strictEqual(sent[3][0], HOT, 'the callback form is left alone');
  assert.deepStrictEqual(sent[3][1], [8]);
});

test('the danger guard still refuses before anything is named', async () => {
  const DROP = prepared('test-drop', 'DROP TABLE users');
  sent = [];
  await assert.rejects(pool.query(DROP, []), /BLOCKED/);
  assert.strictEqual(sent.length, 0);
});

test('any other database error rejects once and the name stays in use', async () => {
  sent = [];
  namedFailure = Object.assign(new Error('connection terminated'), { code: '57P01' });
  await assert.rejects(pool.query(HOT, [7]), /connection terminated/);
  assert.strictEqual(sent.length, 1, 'no second attempt on an unrelated error');
  namedFailure = null;
  sent = [];
  await pool.query(HOT, [7]);
  assert.strictEqual(sent[0][0].name, 'test-hot');
});

test('a changed result row (0A000) answers the same call unnamed, and later calls skip the name', async () => {
  sent = [];
  namedFailure = Object.assign(new Error('cached plan must not change result type'), { code: '0A000' });
  const r = await pool.query(HOT, [7]);
  assert.deepStrictEqual(r.rows, [{ ok: true }]);
  assert.deepStrictEqual(sent, [[{ name: 'test-hot', text: HOT, values: [7] }], [HOT, [7]]]);
  namedFailure = null;
  sent = [];
  await pool.query(HOT, [9]);
  assert.deepStrictEqual(sent, [[HOT, [9]]]);
  assert.strictEqual(preparedName(HOT), null);
});
