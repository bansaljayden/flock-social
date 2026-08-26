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
async function startEmbeddedPostgres(pg) {
  const suite = pg.__flockSuite || 'unknown suite';
  const port = pg.__flockPort;
  try {
    await pg.initialise();
    await pg.start();
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
  }
}

module.exports = {
  pickEmbeddedPgPort,
  isPortFree,
  createEmbeddedPostgres,
  startEmbeddedPostgres,
  SUITE_SLOTS,
  BASE,
  SPAN,
};
