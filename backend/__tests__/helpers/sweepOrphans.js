'use strict';
// Sweep what earlier test runs left behind, before this one starts.
//
// WHY. An embedded-Postgres suite ends by stopping its postmaster and
// removing its data directory (embeddedPgPort.js). On a loaded machine
// that path can fail open: the process-table probe it needs answers empty
// when PowerShell is too slow, the sweep then sweeps nothing, and a forked
// child of the dead postmaster (a bgwriter, a checkpointer) stays alive with
// the data directory open. The suite still exits, because its pipe ends are
// closed, so this is a leak and not a hang: one process and one directory
// per unlucky run, accumulating in %TEMP% and in the process table.
//
// WHAT IT KILLS, AND WHAT IT LEAVES ALONE. Only a postgres.exe that runs
// out of this repository's embedded-postgres binary, whose parent process no
// longer exists, and that is older than a few minutes. A live suite's server
// has a live parent (the node test process) and is seconds old; a Postgres
// installed on the machine for real runs from somewhere else. Killing on
// sight cost a refused push once (2026-09-12): the children of a live suite
// looked like orphans to a hurried eye. The three conditions together are
// what "orphan" means.
//
// Runs as npm's pretest, so every `npm test` starts clean; a direct
// `node --test` does not run it, and does not need to.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIN_AGE_MS = 5 * 60 * 1000;           // a live suite's server is seconds old
const DIR_MIN_AGE_MS = 30 * 60 * 1000;      // a live suite's directory is minutes old
const BINARY_MARK = '@embedded-postgres';   // the path every one of ours runs from

// PowerShell that prints one line per process matching `filter` (a WQL
// condition on Win32_Process): pid, parent, creation time, and the command
// line (which holds the path). The creation time is Unix epoch milliseconds,
// the count Date.now() is in, so an age is one subtraction in one time base.
//
// It used to print CreationDate.Ticks, and that put every age off by the
// machine's UTC offset. CIM hands CreationDate back as LOCAL wall-clock time,
// so its ticks counted local time, and they were subtracted from a "now"
// built out of Date.now(), which counts UTC. On a machine in EDT every process
// was four hours old the moment it started, the age guard passed for all of
// them, and only the parent check stood between a live suite and taskkill;
// that is how two 2-minute-old processes of a running suite were killed. The
// cast to DateTimeOffset applies the zone's offset at the creation instant.
// In the hour a fall-back repeats, .NET reads the ambiguous local time as
// standard time, which can only make a process look younger than it is, so
// an orphan from that hour waits an hour longer to be swept. A process with
// no creation time prints nothing and is never swept.
function processRowsScript(filter) {
  return `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    'ForEach-Object { if ($_.CreationDate) { "PG $($_.ProcessId) $($_.ParentProcessId) ' +
    '$(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()) $($_.CommandLine)" } }';
}

// The probe's output: every pid on the machine from the ALL line, and one
// row per PG line. Lines of any other shape are ignored.
function parseProbe(stdout) {
  const alive = new Set();
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (line.startsWith('ALL ')) {
      for (const p of line.slice(4).trim().split(/\s+/)) if (p) alive.add(Number(p));
    } else if (line.startsWith('PG ')) {
      const m = line.match(/^PG (\d+) (\d+) (\d+) (.*)$/);
      if (m) rows.push({ pid: Number(m[1]), parent: Number(m[2]), createdMs: Number(m[3]), cmd: m[4] || '' });
    }
  }
  return { alive, rows };
}

// The three conditions of the header, all of them: ours, parent gone, and
// at least MIN_AGE_MS old by the one clock both times were read in.
function isOrphan(row, alive, nowMs) {
  const ours = row.cmd.includes(BINARY_MARK);
  const parentGone = !alive.has(row.parent);
  return ours && parentGone && nowMs - row.createdMs >= MIN_AGE_MS;
}

function sweepProcesses() {
  if (process.platform !== 'win32') return { killed: 0, seen: 0 };
  const probe = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    // Every pid on the machine on one line, then one line per postgres.exe.
    '$all = (Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId }) -join " "; ' +
    '"ALL $all"; ' +
    processRowsScript("name='postgres.exe'"),
  ], { encoding: 'utf8', timeout: 60000 });
  if (probe.status !== 0) return { killed: 0, seen: 0, probeFailed: true };
  const { alive, rows } = parseProbe(probe.stdout);
  const now = Date.now();
  let killed = 0;
  for (const r of rows) {
    if (!isOrphan(r, alive, now)) continue;
    try { spawnSync('taskkill', ['/pid', String(r.pid), '/f'], { timeout: 20000 }); killed += 1; } catch (_) { /* best effort */ }
  }
  return { killed, seen: rows.length };
}

function sweepDirectories() {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch (_) { return removed; }
  const cutoff = Date.now() - DIR_MIN_AGE_MS;
  for (const name of names) {
    if (!/^flock-[a-z0-9-]+-pg-/i.test(name)) continue;
    const full = path.join(os.tmpdir(), name);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
    try { fs.rmSync(full, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); removed += 1; } catch (_) { /* still held; next run */ }
  }
  return removed;
}

if (require.main === module) {
  const p = sweepProcesses();
  const d = sweepDirectories();
  const note = p.probeFailed ? ' (process table unavailable, processes left as they are)' : '';
  console.log(`[sweep] ${p.killed} orphaned embedded postgres killed of ${p.seen} seen, ${d} stale data directories removed${note}`);
}

module.exports = {
  sweepProcesses,
  sweepDirectories,
  processRowsScript,
  parseProbe,
  isOrphan,
  MIN_AGE_MS,
  DIR_MIN_AGE_MS,
  BINARY_MARK,
};
