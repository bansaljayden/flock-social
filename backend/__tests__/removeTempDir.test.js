// Run: node --test __tests__/removeTempDir.test.js   (from backend/)
//
// helpers/removeTempDir.js decides which failures at the end of an
// embedded-Postgres suite are a warning and which still fail the file. A
// directory another process holds cannot be produced on demand, so the codes
// that mean "still held" are thrown here by a stubbed fs.rmSync, and so are
// errors that mean something else.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { removeTempDir } = require('./helpers/removeTempDir');

const HELD_DIR = path.join(os.tmpdir(), 'flock-removetempdir-pg-held');

test('a directory nothing holds is removed, and a missing one is nothing to do', () => {
  // Named the way sweepOrphans.js removes, so a failed run here leaves
  // nothing behind that the next run will not clear.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-removetempdir-pg-'));
  fs.mkdirSync(path.join(dir, 'base'));
  fs.writeFileSync(path.join(dir, 'base', 'PG_VERSION'), '18\n');
  removeTempDir(dir, 'removeTempDir');
  assert.strictEqual(fs.existsSync(dir), false);
  removeTempDir(dir, 'removeTempDir');
  removeTempDir(undefined, 'removeTempDir');
});

for (const code of ['EPERM', 'EBUSY', 'ENOTEMPTY']) {
  test(`${code} leaves the directory for the sweep with one warning, and does not throw`, (t) => {
    t.mock.method(fs, 'rmSync', () => { throw Object.assign(new Error(`${code}: still held`), { code }); });
    const warn = t.mock.method(console, 'warn', () => {});
    removeTempDir(HELD_DIR, 'someSuite');
    assert.deepStrictEqual(
      warn.mock.calls.map((c) => c.arguments),
      [[`[someSuite] temp data directory left for the sweep: ${code}`]],
    );
  });
}

test('any other error still fails the hook', (t) => {
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  const badArgument = new TypeError('The "path" argument must be of type string');
  for (const thrown of [denied, badArgument]) {
    const rm = t.mock.method(fs, 'rmSync', () => { throw thrown; });
    const warn = t.mock.method(console, 'warn', () => {});
    assert.throws(() => removeTempDir(HELD_DIR, 'someSuite'), (err) => err === thrown);
    assert.strictEqual(warn.mock.callCount(), 0, 'an error that is thrown is not also warned about');
    rm.mock.restore();
    warn.mock.restore();
  }
});
