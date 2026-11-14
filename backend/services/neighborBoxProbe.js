'use strict';
// ---------------------------------------------------------------------------
// HOW PRODUCTION RUNS THE NEIGHBOUR BOX SCAN (2026-11-13).
//
// The homepage demo's slow cold builds come from one read. Railway's logs for
// 10 to 13 November hold fourteen area builds of 1.5 to 10.0 s
// (routes/publicCrowd.js logBuildTime): the Places search took 0.3 to 0.5 s
// every time and the weather about 0.1 s, while scoring the eight venues took
// 0.2 to 6.2 s and the featured card 0.4 to 4.4 s. Every slow score was the
// neighbour box scan (mlPredictor scanNeighborBox): 1.0 to 5.9 s for 4,500 to
// 11,000 curve rows, against about 0.1 s for each of the score's other three
// reads (noteSlowLookups).
//
// Which part of that is the plan and which is reading the curve table from
// disk cannot be told from the logs, and this database's rule is to read
// production's own plan before changing an index or a statement for speed
// (scripts/ml/buildRecentDeviation.js, "HOW PRODUCTION RUNS THESE": a rewrite
// a local bench called faster was judged in production by guesswork, wrongly).
// So fifteen minutes after boot and every six hours after, this runs the same
// statement (mlPredictor NEIGHBOR_BOX_SQL, the text the scores run) under
// EXPLAIN (ANALYZE, BUFFERS) for one box around a venue picked at random, on a
// weekday picked at random, and logs one line: the time, the curve rows read,
// the shared-buffer misses and hits, and the slowest steps with each one's own
// misses. A random box is usually one nobody has read lately, which is the case
// a demo visitor meets.
//
// A MISS IS NOT PROOF OF A DISK READ. EXPLAIN's "read" blocks are pages that
// were not in Postgres's shared buffers; the operating system's cache may still
// have served them. The read time is what tells the two apart, and EXPLAIN
// reports it only where track_io_timing is on: the line carries it when it is
// there (PostgreSQL 17 names it "Shared I/O Read Time", earlier versions
// "I/O Read Time") and says nothing about disk when it is not.
//
// IT CHANGES NOTHING ANY SCORE READS. It runs off the request path, writes no
// table, and never touches the neighbour cache, the in-flight map or the
// per-account budget, so a score after it reads exactly what it would have
// read without it. Its only cost is one box read every six hours, and it picks
// the venue to centre on from a one-per-cent page sample of ml_venues rather
// than a scan, so the probe does not warm the very pages it is there to
// measure.
// NEIGHBOR_PROBE_DISABLED=true is the kill switch.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { NEIGHBOR_BOX_SQL, NEIGHBOR_BOX_DEG } = require('./mlPredictor');

const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// After boot's own sweeps (the last kickoff is the money watch's at 120 s).
// Deploys come several times a day, so the six-hourly timer alone, which every
// deploy restarts, could go days without firing.
const PROBE_KICKOFF_MS = 15 * 60 * 1000;
// A probe is never worth a long statement on the primary.
const PROBE_TIMEOUT_MS = 30 * 1000;

// One venue, from a random one per cent of ml_venues' pages: a few dozen page
// reads, near enough uniform over venues, where ORDER BY random() over the
// whole table would scan it and warm it first. Not a random point in the id
// range: upserts burn sequence values, so ids have gaps, and the venue after a
// long gap would be picked nearly every time, its box warm from the last probe.
// A sample that lands on no row is a probe skipped, not an error.
const PICK_SQL = `SELECT latitude, longitude
  FROM ml_venues TABLESAMPLE SYSTEM (1)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  ORDER BY random()
  LIMIT 1`;

function probeEnabled() {
  return String(process.env.NEIGHBOR_PROBE_DISABLED || '').toLowerCase() !== 'true';
}

const MB = (blocks) => ((blocks || 0) * 8192 / 1e6).toFixed(1);

// One line from EXPLAIN's JSON. A step's time and misses are its own, its
// children's taken off: EXPLAIN reports both as totals over the step and
// everything under it, and the question is which step did the reading.
//
// IN A PARALLEL PLAN THE STEP TIMES ARE SUMMED OVER THE WORKERS (a step's time
// per loop times its loops), so under a Gather they add up to more than the
// wall clock, the Gather's own share clamps to zero, and the shares are of
// that sum. The line says so when a plan launched workers, rather than passing
// the sum off as elapsed time.
function describeProbe(top) {
  const steps = [];
  let curveRows = 0;
  let workers = 0;
  (function walk(node) {
    if (Number.isFinite(node['Workers Launched'])) workers += node['Workers Launched'];
    const loops = node['Actual Loops'] || 1;
    const kids = node.Plans || [];
    const kidMs = kids.reduce((s, k) => s + (k['Actual Total Time'] || 0) * (k['Actual Loops'] || 1), 0);
    const kidRead = kids.reduce((s, k) => s + (k['Shared Read Blocks'] || 0), 0);
    const rows = Math.round((node['Actual Rows'] || 0) * loops);
    if (node['Relation Name'] === 'ml_venue_baselines') curveRows += rows;
    steps.push({
      node,
      rows,
      ms: Math.max(0, (node['Actual Total Time'] || 0) * loops - kidMs),
      read: Math.max(0, (node['Shared Read Blocks'] || 0) - kidRead),
    });
    kids.forEach(walk);
  })(top.Plan);
  const all = steps.reduce((s, x) => s + x.ms, 0) || 1;
  const name = (n) => n['Node Type']
    + (n['Index Name'] ? ` using ${n['Index Name']}` : '')
    + (n['Relation Name'] ? ` on ${n['Relation Name']}` : '');
  const slowest = steps.filter((x) => x.ms / all >= 0.05).sort((a, b) => b.ms - a.ms).slice(0, 4)
    .map((x) => `${name(x.node)} ${(x.ms / 1000).toFixed(2)} s (${Math.round((100 * x.ms) / all)}%, `
      + `${x.rows.toLocaleString('en-US')} rows, missed ${MB(x.read)} MB)`);
  const r = top.Plan;
  // PostgreSQL 17 renamed the key; absent on either name means track_io_timing
  // is off, and the line then makes no claim about disk.
  const ioMs = r['Shared I/O Read Time'] ?? r['I/O Read Time'];
  return `${((top['Execution Time'] || 0) / 1000).toFixed(2)} s for ${curveRows.toLocaleString('en-US')} curve rows`
    + ` in ${Math.round(r['Actual Rows'] || 0)} slots; shared-buffer misses ${MB(r['Shared Read Blocks'])} MB`
    + ` (${(r['Shared Read Blocks'] || 0).toLocaleString('en-US')} blocks, `
    + `${Number.isFinite(ioMs) ? `${(ioMs / 1000).toFixed(2)} s reading them` : 'read time not tracked'}),`
    + ` hits ${MB(r['Shared Hit Blocks'])} MB; slowest steps: ${slowest.join('; ') || 'none over 5%'}`
    + (workers > 0 ? `; parallel plan, ${workers} worker(s) launched: step times are summed over the workers` : '');
}

let running = false;

// Returns the logged line, or null when nothing ran. Never throws: a probe
// that fails says so in the log and leaves the app alone.
async function runNeighborBoxProbe({ random = Math.random } = {}) {
  if (!probeEnabled() || running) return null;
  running = true;
  let client = null;
  let broken = false;
  try {
    const picked = await pool.query(PICK_SQL);
    const venue = picked.rows && picked.rows[0];
    if (!venue) return null;
    // The box the scores read: centred on the bucketed coordinates, as
    // mlPredictor.getNeighborActivity buckets them.
    const bLat = (+venue.latitude).toFixed(3);
    const bLng = (+venue.longitude).toFixed(3);
    const dow = Math.min(6, Math.floor(random() * 7));
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${PROBE_TIMEOUT_MS}`);
    const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${NEIGHBOR_BOX_SQL}`,
      [Number(bLat), Number(bLng), NEIGHBOR_BOX_DEG, dow]);
    await client.query('COMMIT');
    const doc = res.rows[0]['QUERY PLAN'];
    const top = (typeof doc === 'string' ? JSON.parse(doc) : doc)[0];
    const line = `[neighbour-probe] box ${bLat},${bLng} weekday ${dow}: ${describeProbe(top)}`;
    console.log(line);
    return line;
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => { broken = true; });
    console.warn('[neighbour-probe] failed:', err && err.message);
    return null;
  } finally {
    // A connection whose ROLLBACK failed is not one to hand back to the pool.
    if (client) client.release(broken || undefined);
    running = false;
  }
}

module.exports = {
  runNeighborBoxProbe,
  probeEnabled,
  PROBE_INTERVAL_MS,
  PROBE_KICKOFF_MS,
  __test: { describeProbe, PICK_SQL, PROBE_TIMEOUT_MS },
};
