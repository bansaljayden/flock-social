'use strict';
// ---------------------------------------------------------------------------
// Port allocation for the suites that boot a real embedded Postgres.
//
// THE TRAP THIS REPLACES
// Nine suites used to hardcode a port each (59787, 59641, 59643, ...). That is
// fine until a run is killed: embedded-postgres leaves the `postgres` process
// alive, still bound to the port, and every LATER run of that same suite then
// fails permanently -- not flakily -- until a human finds and kills the orphan.
// It cost a real evening: budgetCeilingBackfill failed 9/9 running completely
// alone, because pid 33128, an orphan of an earlier run of ITSELF, held 59787.
//
// WHY THE PORT MUST BE PICKED SYNCHRONOUSLY
// Six of these suites build a connection string at module scope and assign
// process.env.DATABASE_URL from it BEFORE requiring scripts/ml/*. Those scripts
// call dotenv.config() on backend/.env, which points at the LIVE Railway
// database, and dotenv never overwrites a variable that is already set. So the
// pre-set is the only thing standing between a test run and production. An
// `await freePort()` inside test.before runs after those requires and is far
// too late. Everything here is therefore synchronous by construction.
//
// HOW A PORT IS CHOSEN
//   1. Each suite owns a disjoint 256-port range (BASE + slot * SPAN). Two
//      suites running at once -- node --test gives each file its own process --
//      can never be handed the same port, whatever else happens.
//   2. Inside its range the starting candidate is derived from process.pid. An
//      orphan belongs to a DEAD process with a different pid, so a fresh run
//      does not start where an orphan is squatting.
//   3. That candidate is then confirmed free by an actual bind, in a child
//      process via spawnSync (see probeFreePort.js), walking forward through the
//      range until one binds. Belt and braces: pid derivation alone could in
//      principle collide after enough pid recycling, and a bind probe alone
//      would race two same-instant starts.
//
// The range sits below 49152 deliberately. Windows hands out dynamic client
// ports from 49152 upward, which is exactly where every one of the old
// hardcoded 59xxx ports lived -- a second, quieter way for them to be stolen.
// ---------------------------------------------------------------------------
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROBE = path.join(__dirname, 'probeFreePort.js');

const BASE = 41000;
const SPAN = 256;

// Every suite that boots an embedded Postgres must appear here, with a slot no
// other suite uses. The slots are what makes the ranges disjoint; a typo that
// silently fell back to slot 0 would reintroduce collisions, so an unknown name
// throws instead of guessing.
const SUITE_SLOTS = {
  budgetCeilingBackfill: 0,      // was 59787
  feedbackBackfillMigration: 1,  // was 59641
  mlClockAxisBackfill: 2,        // was 59643
  mlCorpusDedupe: 3,             // was 59647
  mlLabelProvenance: 4,          // was 59651
  mlExportContracts: 5,          // was 59723
  mlFeedbackLabels: 6,           // was 59751
  mlExportColumnGrowth: 7,       // was 59761
  moderationProfileBio: 8,       // was 54411
  migrationBootSafety: 9,        // new in 2026-08-20; never had a hardcoded port
  migrationSearchPath: 10,       // new in 2026-08-20; never had a hardcoded port
  photoSpendLedger: 11,          // new in 2026-08-20; never had a hardcoded port
  flockLifecycle: 12,            // new in 2026-08-25; never had a hardcoded port
  accountDeletionSurface: 13,    // new in 2026-08-26; never had a hardcoded port
  dumpLiteralRestore: 14,        // new in 2026-08-26; never had a hardcoded port
  userSearchRanking: 15,         // new in 2026-08-26; never had a hardcoded port
  demoLocalStack: 16,            // scripts/demoLocalStack.js, not a suite: the
                                 // screenshot demo database. In this registry
                                 // anyway because a fixed port in the dynamic
                                 // range collides exactly the way this file's
                                 // header warns (code review, 2026-09-01).
  mlOpenHoursSkip: 17,           // new in 2026-09-03; the open-hours call filter
  sqlParameterTypes: 18,         // new in 2026-09-22; prepares every static
                                 // statement in the app against a migrated
                                 // schema, so Postgres is the judge of
                                 // whether a parameter's types agree.
  venueBillingWriter: 19,        // new in 2026-09-24; runs the Roost Stripe
                                 // writer's one statement against a real,
                                 // migrated schema.
  usageMeters: 20,               // new in 2026-09-24; the free-tier meters
                                 // written through to usage_meters and
                                 // loaded back as a restart would, and the
                                 // first-week grace computed by Postgres.
  graceIdentity: 21,             // new in 2026-09-24; the first week once per
                                 // identity, through real signup and
                                 // deletion routes (migration 076).
  roostNotice: 23,               // new in 2026-09-24; the Roost notice sweep,
                                 // its window and the deals and digest it keeps
                                 // on (migration 077). 22 is left for a suite
                                 // being written alongside this one.
  checkThenActRaces: 24,         // new in 2026-09-25; bursts against the mail
                                 // budget claims and overlapping Pro syncs, on
                                 // real advisory locks.
  sosStandDownEndsTheChase: 25,  // new in 2026-09-25; an SOS, its stand-down
                                 // and the location follow-up that must not
                                 // outlive it, through the real routes
                                 // (migration 084).
  flockTransactionIntegrity: 26, // new in 2026-09-25; an account deletion
                                 // racing a plan delete, and a plan edit
                                 // whose night-of reset fails, on real locks.
  deviceTokenClaims: 27,         // new in 2026-09-25; which session keeps a
                                 // phone's push token when two registrations
                                 // race, what sign-out deletes, and whose
                                 // clock quiet hours read (migration 085).
  planFlowRaces: 28,             // new in 2026-09-25; overlapping completion
                                 // sweeps, the guest-to-member vote carry and
                                 // the two venue tallies, on real row locks.
  planFlowLocks: 29,             // new in 2026-09-25; whose guest row a join
                                 // may retire, the join/vote lock order, the
                                 // plan closing mid-join, fan-outs under the
                                 // row lock and the un-vote's reads.
  sensorIngestStatement: 31,     // new in 2026-09-25; the one-statement sensor
                                 // ingest run against a real, migrated schema.
                                 // 31 is the last slot below 49152; the gap is
                                 // left for suites written in the same week.
};

// Two suites sharing a slot would silently reintroduce exactly the collision the
// slots exist to prevent, and it would show up as a rare flake rather than as an
// error. Cheap enough to check every time the module loads.
{
  const seen = new Map();
  for (const [suite, slot] of Object.entries(SUITE_SLOTS)) {
    if (seen.has(slot)) {
      throw new Error(
        `embeddedPgPort: slot ${slot} is claimed by both "${seen.get(slot)}" and ` +
        `"${suite}". Every suite needs a slot of its own or their port ranges overlap.`
      );
    }
    seen.set(slot, suite);
  }
}

function rangeFor(suite) {
  const slot = SUITE_SLOTS[suite];
  if (slot === undefined) {
    throw new Error(
      `embeddedPgPort: unknown suite "${suite}". Add it to SUITE_SLOTS in ` +
      `${__filename} with a slot number no other suite uses, so its port range ` +
      'stays disjoint from every other suite that boots an embedded Postgres.'
    );
  }
  return BASE + (slot * SPAN);
}

/**
 * Pick a port for `suite`'s embedded Postgres. Synchronous, so it is safe at
 * module scope, and it never returns a port an orphan of a previous run holds.
 */
function pickEmbeddedPgPort(suite) {
  const base = rangeFor(suite);
  // Math.imul with Knuth's multiplier before the modulo: on Windows pids are
  // multiples of 4, so a bare `pid % SPAN` would only ever reach a quarter of
  // the range.
  const start = base + ((Math.imul(process.pid, 2654435761) >>> 0) % SPAN);

  const probe = spawnSync(
    process.execPath,
    [PROBE, String(base), String(SPAN), String(start)],
    { encoding: 'utf8', timeout: 20000 }
  );
  const found = Number(String(probe.stdout || '').trim());
  if (probe.status === 0 && Number.isInteger(found) && found >= base && found < base + SPAN) {
    return found;
  }
  // The probe itself could not run (a timeout, or a sandbox that blocks spawn).
  // Fall back to the pid-derived port, which is orphan-proof on its own; a real
  // clash then surfaces as the legible startEmbeddedPostgres error below rather
  // than as silence.
  return start;
}

/** True if nothing is listening on `port` right now. Synchronous. */
function isPortFree(port) {
  const probe = spawnSync(
    process.execPath,
    [PROBE, String(port), '1', String(port)],
    { encoding: 'utf8', timeout: 20000 }
  );
  return probe.status === 0;
}

/**
 * Build the EmbeddedPostgres all nine suites want, with its server log captured
 * so that a start failure can quote it.
 */
// WHY EVERY EMBEDDED POSTGRES HERE RUNS WITH io_method=sync.
//
// This is the fix for the orphan leak, and it is not the leak everyone assumed.
// 58 stray `postgres.exe` processes accumulated overnight holding 619 MB, and a
// suite run timed out at 897 s because of them. The assumed cause was "a whole
// embedded cluster survives each run". The process table says otherwise: every
// single orphan was a `--forkchild="io_worker"` whose PARENT pid no longer
// existed. No orphaned postmaster, no orphaned checkpointer, bgwriter, or
// wal_writer -- only io_workers.
//
// That shape names the mechanism exactly. embedded-postgres pins PostgreSQL 18,
// whose default `io_method=worker` starts a pool of io_worker child processes
// that the postmaster never speaks to again. When a test process dies without
// running its `after` hook -- the runner's own timeout kill, a Ctrl-C, a crash --
// `pg.stop()` never runs, so nothing ever calls taskkill on the tree. The
// postmaster and the chatty auxiliaries all write to a stderr pipe whose read
// end just closed with the node process, so they die on their own. The
// io_workers write nothing, notice nothing, and stay bound forever. They are
// the residue of every killed run, which is why they arrive in multiples of
// three and never with a parent.
//
// `io_method=sync` does the I/O on the backend that asked for it and starts no
// io_worker processes at all, so the class of orphan cannot be created. Measured
// on this machine before the change went in: with the flag, the postmaster's
// children are the ordinary auxiliaries and `io_worker count: 0`.
//
// This is a startup-only GUC (`postmaster` context), so it has to be a flag on
// the server command line rather than a `SET`. It costs these suites nothing:
// they run a few thousand rows through a backfill on one connection, which is
// the workload asynchronous I/O has the least to offer.
const NO_IO_WORKERS = ['-c', 'io_method=sync'];

function createEmbeddedPostgres(EmbeddedPostgres, { suite, port, databaseDir }) {
  const log = [];
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    postgresFlags: NO_IO_WORKERS,
    onLog: (message) => {
      log.push(String(message).trimEnd());
      if (log.length > 40) log.shift();
    },
  });
  pg.__flockSuite = suite;
  pg.__flockPort = port;
  pg.__flockLog = log;

  // stop(), with the tree taken down. The library's stop() sends
  // `taskkill /t` to the postmaster, which reaches the children it still
  // has; a child the postmaster had already lost (see STOP_TIMEOUT_MS above)
  // survives it, keeps the stderr pipe, and keeps this process alive after
  // its last test. The descendants are listed while the postmaster is
  // still up, and whatever is left of them after the library's stop is
  // killed by pid.
  const libraryStop = pg.stop.bind(pg);
  pg.stop = async function stopWithSweep() {
    // Nothing running: a second stop. The library's own exit hook calls
    // stop() on every instance it ever made, so this is the normal way
    // out, and it gets no probe to pay for on the way.
    if (!pg.process) return libraryStop();
    const pid = pg.process.pid;
    // The pipes are what keep this process alive when a forked child
    // outlives the postmaster: they are this end of the child's stdio. They
    // are taken before the stop, because the library forgets the process
    // object once it has stopped, and closed after it, whatever the sweep
    // below manages. With them closed the event loop has nothing left to
    // wait on and the suite exits, orphan or no orphan; the orphan is then
    // a leak to clean, not a hang.
    const pipes = [pg.process.stdout, pg.process.stderr].filter(Boolean);
    // Who is ours, read while the postmaster is still up. On Windows the
    // process table names it by parent (this process) and its children by
    // creation order; elsewhere the pid alone is enough, because a POSIX
    // SIGKILL of the postmaster takes its children with it.
    const t0 = Date.now();
    const table = process.platform === 'win32' ? postgresProcessTable() : null;
    const root = table ? ownedPostmaster(pid, table) : { pid, created: null };
    const family = table && root ? descendantsOf(root, table) : [];
    const tProbe = Date.now() - t0;
    let timer = null;
    let stopError = null;
    try {
      await Promise.race([
        libraryStop(),
        new Promise((resolve) => { timer = setTimeout(resolve, STOP_TIMEOUT_MS); timer.unref(); }),
      ]);
    } catch (err) {
      // A stop that throws still gets the sweep below.
      stopError = err;
    } finally {
      if (timer) clearTimeout(timer);
      for (const pipe of pipes) {
        try { pipe.destroy(); } catch (_) { /* already closed */ }
      }
    }
    const tStop = Date.now() - t0;
    // Let the family leave on its own first; kill only what is still here
    // after the grace, which is the orphan this whole path exists for.
    const leftovers = await waitGone(root ? [root, ...family] : family, STOP_GRACE_MS);
    if (leftovers.length) {
      killPostgresProcesses(leftovers);
      // A killed process gives its file handles back a moment after it is
      // gone; the removal below has to wait for that moment, not race it.
      await waitGone(leftovers, STOP_GRACE_MS);
    }
    const tGone = Date.now() - t0;
    // The library removes the data directory inside its own stop, without
    // retries, and a handle still closing makes that throw; the suites then
    // remove it again themselves, most of them without retries either. One
    // patient removal here means neither of those has anything left to trip
    // on.
    // rmSync's own maxRetries did not retry here: on this Node (25) and
    // Windows the removal threw EPERM one millisecond after the postmaster
    // exited, forty retries asked for and none taken (FLOCK_PG_DEBUG showed
    // "rm 769ms" beside "stop 768ms"). The retry is done by hand, with a
    // real wait between attempts, which is what a handle still closing
    // needs.
    const rmError = databaseDir ? await removeDirectoryPatiently(databaseDir, 40, 250) : null;
    // FLOCK_PG_DEBUG=1 prints one line per stop, for the day a teardown
    // misbehaves under load and the question is which step took the time.
    if (process.env.FLOCK_PG_DEBUG) {
      const still = Boolean(databaseDir && fs.existsSync(databaseDir));
      const stopNote = stopError ? ' (threw ' + String((stopError && stopError.code) || stopError) + ')' : '';
      const rmNote = rmError ? ' (rm threw ' + String(rmError.code) + ')' : '';
      console.error('[pg-stop ' + suite + '] probe ' + tProbe + 'ms root=' + (root ? 'yes' : 'no')
        + ' family=' + family.length + ' stop ' + tStop + 'ms' + stopNote
        + ' gone ' + tGone + 'ms leftovers=' + leftovers.length
        + ' rm ' + (Date.now() - t0) + 'ms' + rmNote + ' dir-still-there=' + still);
    }
  };
  return pg;
}

/**
 * initialise() + start(), but failing legibly.
 *
 * embedded-postgres rejects its start promise with a bare `reject()` when the
 * server process exits early (node_modules/embedded-postgres/dist/index.js), so
 * the rejection value is literally `undefined`. node:test reports that as
 * `hookFailed: undefined`, and every test in the file then fails with no hint at
 * all about the cause. That opacity was half of what made the orphan trap
 * expensive to diagnose, so this always throws a real Error naming the suite,
 * the port, and whether something is squatting on it.
 */
// How long a start may take before it is called a hang. The library resolves
// start() on the server's "ready to accept connections" line and rejects it
// only when the server PROCESS closes, so a server that does neither would
// hold the suite forever. A cold start on this machine is two to five
// seconds; anything past ninety is not a slow start, and a legible failure
// costs the pre-push hook one retry instead of the evening.
//
// This is NOT where the 2026-09-11 stalls were, though it was written on
// that theory. Three full runs that evening sat for twenty minutes in an
// embedded-Postgres suite whose tests had all PASSED: the postmaster was
// gone, a `--forkchild="startup"` child of it was still alive with no
// parent, and that child had inherited the stderr pipe the test process
// held. An open pipe keeps a Node event loop alive, so the test process
// could not exit, and the runner waited on it. Killing the orphan by hand
// let the process exit within seconds and the run report every test green.
// The fence for that is in the stop path below.
const START_TIMEOUT_MS = 90000;

// How long a stop may take before the tree is taken down by force.
const STOP_TIMEOUT_MS = 30000;

// How long the postmaster's children get to leave on their own after it is
// told to stop, before any of them is killed. The library's `taskkill /t`
// reaches them, and a checkpointer that is flushing takes a moment to close
// its files; killing it mid-flush leaves handles on the data directory that
// the suite's own rm then trips over (EPERM on the directory, seen on two
// suites the first time the sweep shipped). Only what is still alive after
// this grace is an orphan.
const STOP_GRACE_MS = 5000;

// Remove a directory that a process may still be letting go of. Returns
// null on success, the last error otherwise. Each attempt is a plain
// rmSync; the waiting between them is ours, because rmSync's maxRetries
// was seen taking no retries at all on Windows (see the call site).
async function removeDirectoryPatiently(dir, attempts, delayMs) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return null;
    } catch (err) {
      last = err;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(err && err.code)) return err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return last;
}

// Alive by the OS's word, not the process table probe: cheap enough to poll.
// On Windows a permission error still means the process exists. This says
// only that SOME process has the pid; identity is checked again, by birth,
// before anything is killed.
function alivePid(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// Entries are { pid, created }; the ones whose pid is still taken after `ms`.
async function waitGone(entries, ms) {
  const end = Date.now() + ms;
  let left = entries.filter((e) => alivePid(e.pid));
  while (left.length && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    left = left.filter((e) => alivePid(e.pid));
  }
  return left;
}

// Every postgres.exe on the machine: pid -> { parent, created }. `created`
// is the creation time in ticks, the second half of a process's identity:
// Windows hands a dead process's pid to the next process quickly, and the
// parent pid it records is the creator's pid whether or not that creator
// is still alive, so a pid alone can name a stranger. Windows only; an
// empty map elsewhere. The probe can fail (no PowerShell, a machine too
// loaded to answer in a minute); it then answers empty, the sweep sweeps
// nothing, and the pipes closed above still let the suite exit. That is a
// leak to clean, not a hang.
function postgresProcessTable() {
  const table = new Map();
  if (process.platform !== 'win32') return table;
  const probe = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"name='postgres.exe'\" | " +
    'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.Ticks)" }',
  ], { encoding: 'utf8', timeout: 60000 });
  if (probe.status !== 0) return table;
  for (const line of String(probe.stdout || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+) (\d+) (\d+)$/);
    if (m) table.set(Number(m[1]), { parent: Number(m[2]), created: m[3] });
  }
  return table;
}

// The postmaster THIS process spawned: a postgres.exe at `pid` whose parent
// is this process. Null when it is gone, or when the pid now belongs to
// something else.
function ownedPostmaster(pid, table) {
  if (!pid) return null;
  const row = table.get(pid);
  return row && row.parent === process.pid ? { pid, created: row.created } : null;
}

// The postmaster's descendants, however many forks deep, each with its
// birth. A child is never older than its parent, so a row that names the
// postmaster's pid as parent but was created before the postmaster is a
// stranger whose real parent died and whose pid the postmaster inherited.
function descendantsOf(root, table) {
  const found = new Map();
  if (!root || !table) return [];
  const createdOf = (p) => (p === root.pid ? root.created : (found.get(p) || {}).created);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, row] of table) {
      if (pid === root.pid || found.has(pid)) continue;
      if (row.parent !== root.pid && !found.has(row.parent)) continue;
      const parentCreated = createdOf(row.parent);
      if (parentCreated == null || BigInt(row.created) < BigInt(parentCreated)) continue;
      found.set(pid, { pid, created: row.created });
      grew = true;
    }
  }
  return [...found.values()];
}

// Kill the listed processes, each checked against a fresh table just
// before its own kill, by pid AND birth: the same pid with a different
// birth is somebody else. Each is named on its own, without /t, so a kill
// cannot cascade into pids the list does not know about. Elsewhere than
// Windows the list holds the postmaster alone and SIGKILL reaches it.
function killPostgresProcesses(entries) {
  for (const e of entries) {
    if (process.platform === 'win32') {
      const now = postgresProcessTable().get(e.pid);
      if (!now || now.created !== e.created) continue;
      try { spawnSync('taskkill', ['/pid', String(e.pid), '/f'], { timeout: 20000 }); } catch (_) { /* best effort */ }
    } else {
      try { process.kill(e.pid, 'SIGKILL'); } catch (_) { /* gone already */ }
    }
  }
}

async function startEmbeddedPostgres(pg) {
  const suite = pg.__flockSuite || 'unknown suite';
  const port = pg.__flockPort;
  let timer = null;
  try {
    await pg.initialise();
    await Promise.race([
      pg.start(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          // Take the tree down, but only the tree this process owns: the
          // postmaster is the postgres.exe at this pid whose parent is this
          // process, its children follow by creation order, and a pid that
          // Windows has since handed to somebody else is left alone. The
          // pipes are let go too, so a start that never came up cannot hold
          // the suite open the way a stop once could.
          const proc = pg.process;
          const pid = proc && proc.pid;
          if (process.platform === 'win32') {
            const table = postgresProcessTable();
            const root = ownedPostmaster(pid, table);
            const family = root ? descendantsOf(root, table) : [];
            killPostgresProcesses(root ? [root, ...family] : family);
          } else if (pid) {
            try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone already */ }
          }
          for (const pipe of proc ? [proc.stdout, proc.stderr] : []) {
            try { if (pipe) pipe.destroy(); } catch (_) { /* already closed */ }
          }
          reject(new Error(`no "ready to accept connections" within ${START_TIMEOUT_MS / 1000}s`));
        }, START_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } catch (err) {
    const occupied = port !== undefined && !isPortFree(port);
    const lines = [
      `Embedded Postgres for ${suite} failed to start on 127.0.0.1:${port}.`,
    ];
    if (occupied) {
      lines.push(
        `Port ${port} is HELD BY ANOTHER PROCESS. The overwhelmingly likely cause is an`,
        'orphaned embedded-postgres left behind by a test run that was killed or crashed.',
        `  Windows:      Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object OwningProcess`,
        '                Get-Process postgres | Stop-Process -Force',
        `  macOS/Linux:  lsof -iTCP:${port} -sTCP:LISTEN`,
        '                pkill -f "postgres -D .*flock"'
      );
    } else {
      lines.push(
        `Nothing is listening on ${port}, so this is NOT a squatted port. Read the`,
        'server log below instead (bad data dir, missing initdb locale, out of disk).'
      );
    }
    // Prefer the server's own log lines. The captured buffer also holds initdb's
    // chatter about locales and shared_buffers, which is never the reason a start
    // failed and only pushes the FATAL off the top of the excerpt.
    const log = (pg.__flockLog || []).filter(Boolean);
    const serverLines = log.filter((l) => /\b(LOG|FATAL|PANIC|ERROR|WARNING|HINT):/.test(l));
    const excerpt = serverLines.length ? serverLines : log;
    if (excerpt.length) {
      lines.push('', 'Last lines of the postgres server log:', ...excerpt.slice(-15));
    }
    lines.push(
      '',
      `Underlying rejection: ${err === undefined
        ? 'undefined (embedded-postgres rejects with no value when the server process exits early)'
        : ((err && err.stack) || err)}`
    );
    throw new Error(lines.join('\n'));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  removeDirectoryPatiently,
  START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  STOP_GRACE_MS,
  postgresProcessTable,
  ownedPostmaster,
  descendantsOf,
  killPostgresProcesses,
  pickEmbeddedPgPort,
  isPortFree,
  createEmbeddedPostgres,
  startEmbeddedPostgres,
  SUITE_SLOTS,
  BASE,
  SPAN,
};
