// Run: node --test  (from backend/)
//
// THE NEIGHBOUR BOX PROBE (services/neighborBoxProbe.js), pinned:
//   1. It times the statement the scores run, word for word, on the box the
//      scores would read (bucketed coordinates, the shared width, a weekday).
//   2. It runs under a short statement timeout inside its own transaction and
//      hands its connection back whatever happens.
//   3. It changes nothing a score reads: no neighbour cache entry, no in-flight
//      entry.
//   4. It never throws, and the kill switch stops it before any query.
//   5. Its line names the step that missed the shared buffers, with the
//      misses of the steps under it taken off, never calls a miss a disk
//      read, and says when a parallel plan's step times are summed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pool = require('../config/database');
const ml = require('../services/mlPredictor');
const probe = require('../services/neighborBoxProbe');

const { describeProbe } = probe.__test;

// A plan in the shape EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) returns: an
// aggregate over a nested loop of the venue box and the curve table's key.
function planDoc() {
  return [{
    'Execution Time': 2915.4,
    Plan: {
      'Node Type': 'Aggregate',
      'Actual Total Time': 2915.0,
      'Actual Rows': 24,
      'Actual Loops': 1,
      'Shared Hit Blocks': 900,
      'Shared Read Blocks': 4000,
      Plans: [{
        'Node Type': 'Nested Loop',
        'Actual Total Time': 2900.0,
        'Actual Rows': 4512,
        'Actual Loops': 1,
        'Shared Hit Blocks': 900,
        'Shared Read Blocks': 4000,
        Plans: [
          {
            'Node Type': 'Index Scan',
            'Index Name': 'idx_ml_venues_lat_lng',
            'Relation Name': 'ml_venues',
            'Actual Total Time': 100.0,
            'Actual Rows': 188,
            'Actual Loops': 1,
            'Shared Hit Blocks': 300,
            'Shared Read Blocks': 200,
          },
          {
            'Node Type': 'Index Scan',
            'Index Name': 'ml_venue_baselines_pkey',
            'Relation Name': 'ml_venue_baselines',
            'Actual Total Time': 14.0,
            'Actual Rows': 24,
            'Actual Loops': 188,
            'Shared Hit Blocks': 600,
            'Shared Read Blocks': 3800,
          },
        ],
      }],
    },
  }];
}

test('the line names the curve table read as the slow step, with its own misses', () => {
  const line = describeProbe(planDoc()[0]);
  assert.match(line, /^2\.92 s for 4,512 curve rows in 24 slots; shared-buffer misses 32\.8 MB \(4,000 blocks, read time not tracked\), hits 7\.4 MB;/);
  // 188 loops of 14 ms = 2,632 ms of the 2,915 ms, the largest share.
  assert.match(line, /slowest steps: Index Scan using ml_venue_baselines_pkey on ml_venue_baselines 2\.63 s \(90%, 4,512 rows, missed 31\.1 MB\)/);
  // The nested loop's own time is what is left after its children: 2,900 -
  // 100 - 2,632 = 168 ms (6%), and it missed nothing itself (its 4,000 blocks
  // are the children's).
  assert.match(line, /Nested Loop 0\.17 s \(6%, 4,512 rows, missed 0\.0 MB\)/);
  // A serial plan says nothing about workers.
  assert.doesNotMatch(line, /parallel/);
  // A miss is not a disk read, so the line never says disk.
  assert.doesNotMatch(line, /disk/);
});

test('the read time is named under either version\'s key, and its absence is said', () => {
  const doc = planDoc()[0];
  assert.match(describeProbe(doc), /\(4,000 blocks, read time not tracked\)/);
  // PostgreSQL 16 and earlier.
  doc.Plan['I/O Read Time'] = 2710.5;
  assert.match(describeProbe(doc), /\(4,000 blocks, 2\.71 s reading them\)/);
  // PostgreSQL 17 renamed it; the new key wins when both are there.
  delete doc.Plan['I/O Read Time'];
  doc.Plan['Shared I/O Read Time'] = 1204.0;
  assert.match(describeProbe(doc), /\(4,000 blocks, 1\.20 s reading them\)/);
  // Tracked and zero is a measurement (everything came from the OS cache).
  doc.Plan['Shared I/O Read Time'] = 0;
  assert.match(describeProbe(doc), /\(4,000 blocks, 0\.00 s reading them\)/);
});

test('a parallel plan says its step times are summed over the workers', () => {
  // A Gather of 1.1 s over a scan run by the leader and two workers: 0.8 s a
  // loop over three loops is 2.4 s of summed time, more than the wall clock.
  const doc = {
    'Execution Time': 1100,
    Plan: {
      'Node Type': 'Gather',
      'Workers Planned': 2,
      'Workers Launched': 2,
      'Actual Total Time': 1100,
      'Actual Rows': 24,
      'Actual Loops': 1,
      'Shared Hit Blocks': 10,
      'Shared Read Blocks': 500,
      Plans: [{
        'Node Type': 'Parallel Seq Scan',
        'Relation Name': 'ml_venue_baselines',
        'Actual Total Time': 800,
        'Actual Rows': 8,
        'Actual Loops': 3,
        'Shared Hit Blocks': 10,
        'Shared Read Blocks': 500,
      }],
    },
  };
  const line = describeProbe(doc);
  assert.match(line, /; parallel plan, 2 worker\(s\) launched: step times are summed over the workers$/);
  // The scan is 2.4 s of summed time; the Gather's own share clamps to zero
  // instead of going negative, so it is not listed.
  assert.match(line, /slowest steps: Parallel Seq Scan on ml_venue_baselines 2\.40 s \(100%, 24 rows, missed 4\.1 MB\);/);
  assert.doesNotMatch(line, /Gather -?\d/);
});

test('the venue to centre on comes from a page sample, not a scan or the id range', () => {
  const { PICK_SQL } = probe.__test;
  assert.match(PICK_SQL, /FROM ml_venues TABLESAMPLE SYSTEM \(1\)/);
  // A random point in the id range weights each venue by the gap before its
  // id, and ids have gaps (upserts burn sequence values).
  assert.doesNotMatch(PICK_SQL, /MAX\(id\)|id >=/);
});

// pool stubs: the venue pick goes through pool.query, the timed statement
// through its own connection.
function stubPool({ venue = { latitude: '40.12345', longitude: '-75.45678' }, explainError = null } = {}) {
  const seen = { pick: 0, client: [], released: [] };
  pool.query = async (text) => {
    if (/FROM ml_venues/.test(text) && /random\(\)/.test(text)) {
      seen.pick += 1;
      return { rows: venue ? [venue] : [] };
    }
    throw new Error(`unexpected pool.query: ${String(text).slice(0, 60)}`);
  };
  pool.connect = async () => ({
    query: async (text, params) => {
      seen.client.push({ text, params });
      if (String(text).startsWith('EXPLAIN')) {
        if (explainError) throw explainError;
        return { rows: [{ 'QUERY PLAN': planDoc() }] };
      }
      return { rows: [] };
    },
    release: (arg) => { seen.released.push(arg); },
  });
  return seen;
}

test('it times the statement the scores run, on the box a score would read', async () => {
  delete process.env.NEIGHBOR_PROBE_DISABLED;
  const seen = stubPool();
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let line;
  try {
    line = await probe.runNeighborBoxProbe({ random: () => 0.99 });
  } finally {
    console.log = log;
  }
  assert.strictEqual(seen.pick, 1);
  const texts = seen.client.map((q) => q.text);
  assert.deepStrictEqual(texts.slice(0, 2), ['BEGIN', `SET LOCAL statement_timeout = ${probe.__test.PROBE_TIMEOUT_MS}`]);
  assert.strictEqual(texts[2], `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${ml.NEIGHBOR_BOX_SQL}`);
  // Bucketed as getNeighborActivity buckets (three decimals), the shared box
  // width, and a weekday in 0..6 (random 0.99 -> 6).
  assert.deepStrictEqual(seen.client[2].params, [40.123, -75.457, ml.NEIGHBOR_BOX_DEG, 6]);
  assert.strictEqual(texts[3], 'COMMIT');
  assert.deepStrictEqual(seen.released, [undefined], 'the connection goes back to the pool, healthy');
  assert.match(line, /^\[neighbour-probe\] box 40\.123,-75\.457 weekday 6: 2\.92 s for 4,512 curve rows/);
  assert.deepStrictEqual(logs, [line]);
});

test('the probe writes nothing a score reads', async () => {
  delete process.env.NEIGHBOR_PROBE_DISABLED;
  stubPool();
  const before = { cache: ml._internals.neighborCacheSize(), inflight: ml._internals.neighborInflightSize() };
  const log = console.log;
  console.log = () => {};
  try {
    await probe.runNeighborBoxProbe({ random: () => 0.1 });
  } finally {
    console.log = log;
  }
  assert.deepStrictEqual(
    { cache: ml._internals.neighborCacheSize(), inflight: ml._internals.neighborInflightSize() },
    before
  );
});

test('a failed statement is logged, rolled back and never thrown', async () => {
  delete process.env.NEIGHBOR_PROBE_DISABLED;
  const seen = stubPool({ explainError: new Error('canceling statement due to statement timeout') });
  const warns = [];
  const warn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let out;
  try {
    out = await probe.runNeighborBoxProbe({ random: () => 0.5 });
  } finally {
    console.warn = warn;
  }
  assert.strictEqual(out, null);
  assert.ok(seen.client.some((q) => q.text === 'ROLLBACK'), 'the transaction is rolled back');
  assert.deepStrictEqual(seen.released, [undefined]);
  assert.match(warns.join('\n'), /\[neighbour-probe\] failed: canceling statement due to statement timeout/);
});

test('no venue to centre on means no probe, quietly', async () => {
  delete process.env.NEIGHBOR_PROBE_DISABLED;
  const seen = stubPool({ venue: null });
  assert.strictEqual(await probe.runNeighborBoxProbe(), null);
  assert.strictEqual(seen.client.length, 0);
});

test('the kill switch stops it before any query', async () => {
  process.env.NEIGHBOR_PROBE_DISABLED = 'true';
  try {
    const seen = stubPool();
    assert.strictEqual(probe.probeEnabled(), false);
    assert.strictEqual(await probe.runNeighborBoxProbe(), null);
    assert.strictEqual(seen.pick, 0);
    assert.strictEqual(seen.client.length, 0);
  } finally {
    delete process.env.NEIGHBOR_PROBE_DISABLED;
  }
});

test('the scores and the probe share one statement', () => {
  const source = fs
    .readFileSync(path.join(__dirname, '..', 'services', 'mlPredictor.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const start = source.indexOf('async function scanNeighborBox');
  const end = source.indexOf('async function getNeighborActivity', start);
  assert.ok(start !== -1 && end > start, 'scanNeighborBox is gone from mlPredictor.js');
  assert.match(source.slice(start, end), /pool\.query\(\s*NEIGHBOR_BOX_SQL,/,
    'the scan must run NEIGHBOR_BOX_SQL, the text the probe times');
  assert.match(ml.NEIGHBOR_BOX_SQL, /AS sum_bl/);
  assert.match(ml.NEIGHBOR_BOX_SQL, /b\.day_of_week = \$4/);
});

test('server.js starts the probe after boot and clears both timers on shutdown', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/services\/neighborBoxProbe'\)/);
  assert.match(server, /neighborProbeInterval = setInterval\(runNeighborBoxProbe, NEIGHBOR_PROBE_MS\)/);
  assert.match(server, /neighborProbeKickoff = setTimeout\(runNeighborBoxProbe, NEIGHBOR_PROBE_KICKOFF_MS\)/);
  assert.match(server, /if \(neighborProbeInterval\) clearInterval\(neighborProbeInterval\);/);
  assert.match(server, /if \(neighborProbeKickoff\) clearTimeout\(neighborProbeKickoff\);/);
});
