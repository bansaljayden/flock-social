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
//   5. Its line names the step that read from disk, with the reads of the
//      steps under it taken off.

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

test('the line names the curve table read as the slow step, with its own disk reads', () => {
  const line = describeProbe(planDoc()[0]);
  assert.match(line, /^2\.92 s for 4,512 curve rows in 24 slots; from disk 32\.8 MB \(4,000 blocks\), from cache 7\.4 MB;/);
  // 188 loops of 14 ms = 2,632 ms of the 2,915 ms, the largest share.
  assert.match(line, /slowest steps: Index Scan using ml_venue_baselines_pkey on ml_venue_baselines 2\.63 s \(90%, 4,512 rows, from disk 31\.1 MB\)/);
  // The nested loop's own time is what is left after its children: 2,900 -
  // 100 - 2,632 = 168 ms (6%), and it read nothing itself (its 4,000 blocks
  // are the children's).
  assert.match(line, /Nested Loop 0\.17 s \(6%, 4,512 rows, from disk 0\.0 MB\)/);
});

test('the read time is named when the server tracks it, and left out when it does not', () => {
  const doc = planDoc()[0];
  assert.doesNotMatch(describeProbe(doc), /s reading/);
  doc.Plan['I/O Read Time'] = 2710.5;
  assert.match(describeProbe(doc), /\(4,000 blocks, 2\.71 s reading\)/);
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
