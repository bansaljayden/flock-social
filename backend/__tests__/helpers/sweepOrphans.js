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

function sweepProcesses() {
  if (process.platform !== 'win32') return { killed: 0, seen: 0 };
  const probe = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    // Every pid on the machine on one line, then one line per postgres.exe:
    // pid, parent, creation ticks, and the command line (which holds the path).
    '$all = (Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId }) -join " "; ' +
    '"ALL $all"; ' +
    "Get-CimInstance Win32_Process -Filter \"name='postgres.exe'\" | " +
    'ForEach-Object { "PG $($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.Ticks) $($_.CommandLine)" }',
  ], { encoding: 'utf8', timeout: 60000 });
  if (probe.status !== 0) return { killed: 0, seen: 0, probeFailed: true };
  const lines = String(probe.stdout || '').split(/\r?\n/);
  const alive = new Set();
  const rows = [];
  for (const line of lines) {
    if (line.startsWith('ALL ')) {
      for (const p of line.slice(4).trim().split(/\s+/)) if (p) alive.add(Number(p));
    } else if (line.startsWith('PG ')) {
      const m = line.match(/^PG (\d+) (\d+) (\d+) (.*)$/);
      if (m) rows.push({ pid: Number(m[1]), parent: Number(m[2]), ticks: BigInt(m[3]), cmd: m[4] || '' });
    }
  }
  // .NET ticks are 100 ns since 0001-01-01; JS epoch ms sit 62135596800000 ms later.
  const nowTicks = BigInt(Date.now() + 62135596800000) * 10000n;
  let killed = 0;
  for (const r of rows) {
    const ageMs = Number((nowTicks - r.ticks) / 10000n);
    const ours = r.cmd.includes(BINARY_MARK);
    const orphan = !alive.has(r.parent);
    if (!ours || !orphan || ageMs < MIN_AGE_MS) continue;
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

module.exports = { sweepProcesses, sweepDirectories, MIN_AGE_MS, DIR_MIN_AGE_MS };
