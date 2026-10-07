// Run: node --test  (from backend/)
//
// helpers/sweepOrphans.js runs as npm's pretest and kills the postgres.exe
// processes earlier runs left behind. It may kill one only when all three
// hold: it runs out of this repository's embedded-postgres binary, its parent
// is gone, and it is older than MIN_AGE_MS. The age is what protects a live
// suite when the parent check misreads it, because a live suite's server is
// seconds old.
//
// THE AGE WAS OFF BY THE MACHINE'S UTC OFFSET. The probe printed
// CreationDate.Ticks, which CIM gives in local wall-clock time, and the sweep
// subtracted that from a "now" built out of Date.now(), which counts UTC. On a
// machine in EDT every process was four hours old the moment it started, so
// the guard never held. The last test below probes a process this file starts,
// through the same PowerShell line the sweep runs, and fails under that code
// on any machine whose time zone is not UTC.
//
// Nothing in this file kills anything: it calls the probe, the parser and the
// decision, never the sweep.

const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');

const {
  processRowsScript,
  parseProbe,
  isOrphan,
  MIN_AGE_MS,
  BINARY_MARK,
} = require('./helpers/sweepOrphans');

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const OURS = `C:\\repo\\backend\\node_modules\\${BINARY_MARK}\\windows-x64\\native\\bin\\postgres.exe -D C:\\Temp\\flock-x-pg-1`;
const row = (fields) => ({ pid: 4242, parent: 4141, createdMs: NOW, cmd: OURS, ...fields });
const NO_PARENT_ALIVE = new Set();

test('a process younger than the guard is left alone, though its parent is gone', () => {
  for (const ageMs of [0, 1000, 2 * 60 * 1000, MIN_AGE_MS - 1]) {
    assert.strictEqual(isOrphan(row({ createdMs: NOW - ageMs }), NO_PARENT_ALIVE, NOW), false,
      `${ageMs} ms old is a live suite's age and must not be killed`);
  }
  for (const ageMs of [MIN_AGE_MS, 10 * 60 * 1000, 24 * 60 * 60 * 1000]) {
    assert.strictEqual(isOrphan(row({ createdMs: NOW - ageMs }), NO_PARENT_ALIVE, NOW), true,
      `${ageMs} ms old with no parent is what the sweep is for`);
  }
});

test('a live parent, or a postgres that is not ours, is never swept however old', () => {
  const old = NOW - 24 * 60 * 60 * 1000;
  assert.strictEqual(isOrphan(row({ createdMs: old }), new Set([4141]), NOW), false,
    'a process whose parent is alive belongs to somebody running');
  assert.strictEqual(
    isOrphan(row({ createdMs: old, cmd: '"C:\\Program Files\\PostgreSQL\\17\\bin\\postgres.exe" -D data' }), NO_PARENT_ALIVE, NOW),
    false, 'a Postgres installed on the machine is not ours to kill');
});

test('the probe output is read as pids and epoch milliseconds, and a row with no birth is dropped', () => {
  const out = [
    'ALL 0 4 4141 9000',
    `PG 4242 4141 ${NOW} ${OURS}`,
    'PG 4343 4242  C:\\no\\creation\\time\\postgres.exe',
    'WARNING: anything else PowerShell printed',
    '',
  ].join('\r\n');
  const { alive, rows } = parseProbe(out);
  assert.deepStrictEqual([...alive], [0, 4, 4141, 9000]);
  assert.deepStrictEqual(rows, [{ pid: 4242, parent: 4141, createdMs: NOW, cmd: OURS }],
    'a process that cannot be aged must never become a row the sweep can kill');
});

test('a process started a moment ago is a moment old by the probe the sweep runs', {
  skip: process.platform !== 'win32' && 'the process probe is Windows-only, as the sweep is',
}, async () => {
  // A stand-in for a live suite's server: its command line carries the mark,
  // and its parent is counted as gone below, so its age is all that can keep
  // it alive. The sweep itself looks only at postgres.exe and never sees it.
  const before = Date.now();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', `${BINARY_MARK}-age-guard-probe`],
    { stdio: 'ignore', windowsHide: true });
  const after = Date.now();
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const probe = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', processRowsScript(`ProcessId=${child.pid}`)],
      { encoding: 'utf8', timeout: 120000, windowsHide: true });
    const now = Date.now();
    assert.strictEqual(probe.status, 0, `the probe did not answer: ${probe.stderr || probe.error}`);
    const { rows } = parseProbe(probe.stdout);
    assert.strictEqual(rows.length, 1, `expected one row for pid ${child.pid}, got: ${probe.stdout}`);
    const [r] = rows;
    assert.strictEqual(r.pid, child.pid);
    assert.strictEqual(r.parent, process.pid);
    assert.ok(r.cmd.includes(BINARY_MARK), r.cmd);
    // Born between `before` and `after`, give or take a second for the
    // resolution of the two clocks.
    assert.ok(r.createdMs >= before - 1000 && r.createdMs <= after + 1000,
      `the probe dates this process ${Math.round((r.createdMs - before) / 60000)} minutes from when it started; ` +
      'a whole number of hours off is local wall-clock time read as UTC');
    assert.strictEqual(isOrphan(r, NO_PARENT_ALIVE, now), false,
      `started at most ${now - before} ms ago, the process reads as ${now - r.createdMs} ms old, ` +
      `past the ${MIN_AGE_MS} ms guard: the sweep would kill a live suite's server`);
  } finally {
    child.kill();
  }
});
