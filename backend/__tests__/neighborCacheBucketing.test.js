// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE NEIGHBOUR CACHE DEFEATED THE COORDINATE BUCKETING — audit round 3, I3-2
// ---------------------------------------------------------------------------
// 2878da5 bucketed the caller's coordinates to 2 decimals in
// POST /api/crowd/batch so the event cache, the weather bucket and this cache
// would collapse. It worked for the event cache. It did nothing here, because
// the neighbour key was `lat.toFixed(3)_lng.toFixed(3)_place_id` and `place_id`
// on that route is deliberately not shape-checked:
//
//     {"venues":[{"place_id":"aaa000001","location":{"latitude":40.71,...}},
//                {"place_id":"aaa000002","location":{"latitude":40.71,...}}, ...]}
//
// Twenty items, one location, twenty unique ids — twenty guaranteed misses, and
// a miss is the lat/lng RANGE SCAN over ml_venues ⋈ ml_venue_baselines. The
// audit measured ~4,000 of those a minute from a single account, against the
// primary pool (20 connections, 15-second statement timeout).
//
// WHAT THIS FILE PINS.
//
//   1. Two different place ids at coordinates in the SAME bucket produce ONE
//      range scan, not two — the attack request above, reduced to one query.
//   2. A genuinely different area still queries. A cache that collapses
//      everything is not a fix, it is a wrong answer.
//   3. The venue is still excluded from its own neighbourhood, ARITHMETICALLY
//      rather than by a `!=` in the WHERE clause, which is what makes the
//      shared entry legitimate. This is the parity half: it is the same
//      subtraction scripts/ml/train/prepare_features.py add_neighbor_features
//      performs (window totals first, self taken off afterwards).
//   4. The range-scan SQL no longer carries a place id at all.
//
// No database. pool.query dispatches on the CLAUSE UNDER TEST — the two
// statements are told apart by their own WHERE clauses, not by a prefix — and
// an unrecognised statement is RECORDED and asserted against.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-neighbor-bucketing';

const pool = require('../config/database');
const { _internals } = require('../services/mlPredictor');
const { getNeighborActivity } = _internals;

// ── The corpus the fake range scan answers from ─────────────────────────────
// Four venues around one Manhattan block plus one in Los Angeles. Every venue
// carries a baseline for (dow 5, hour 21) only; nothing else is asked for.
const DOW = 5;
const HOUR = 21;
const VENUES = [
  { id: 'ChIJ_nyc_a', lat: 40.7100, lng: -74.0100, baseline: 40 },
  { id: 'ChIJ_nyc_b', lat: 40.7104, lng: -74.0102, baseline: 60 },
  { id: 'ChIJ_nyc_c', lat: 40.7096, lng: -74.0098, baseline: 80 },
  { id: 'ChIJ_la_a', lat: 34.0500, lng: -118.2400, baseline: 10 },
];
const BOX = 0.0075;

let rangeScans = [];   // one entry per bounding-box scan — the cost under audit
let selfSeeks = [];    // one entry per place-keyed index seek
let unknown = [];

const realQuery = pool.query;
pool.query = (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();

  // The range scan: no equality on google_place_id anywhere, a BETWEEN on both
  // coordinates, aggregated per dow/hour.
  if (/FROM ml_venues v/.test(sql)
      && /v\.latitude BETWEEN/.test(sql)
      && /GROUP BY b\.day_of_week, b\.hour/.test(sql)) {
    rangeScans.push({ sql, params });
    const [lat, lng] = params.map(Number);
    const inBox = VENUES.filter((v) => Math.abs(v.lat - lat) <= BOX && Math.abs(v.lng - lng) <= BOX);
    if (inBox.length === 0) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [{
        dow: DOW,
        hour: HOUR,
        cnt: inBox.length,
        sum_bl: String(inBox.reduce((a, v) => a + v.baseline, 0)),
      }],
      rowCount: 1,
    });
  }

  // The self seek: keyed on google_place_id, no BETWEEN.
  if (/FROM ml_venues v/.test(sql) && /WHERE v\.google_place_id = \$1/.test(sql)) {
    selfSeeks.push({ sql, params });
    const v = VENUES.find((x) => x.id === params[0]);
    if (!v) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [{ lat: String(v.lat), lng: String(v.lng), dow: DOW, hour: HOUR, baseline: String(v.baseline) }],
      rowCount: 1,
    });
  }

  unknown.push(sql);
  return Promise.resolve({ rows: [], rowCount: 0 });
};

test.after(() => {
  pool.query = realQuery;
  return pool.end().catch(() => {});
});
test.beforeEach(() => {
  _internals.__resetNeighborCaches();
  rangeScans = [];
  selfSeeks = [];
  unknown = [];
});

const assertModelled = () =>
  assert.deepStrictEqual(unknown, [], 'fixture did not model a query the predictor ran');

// ── 1. The attack request, collapsed ────────────────────────────────────────

test('two different place ids at coordinates in the same bucket cost ONE range scan', async () => {
  const a = await getNeighborActivity('aaa000001', 40.71, -74.01, DOW, HOUR);
  const b = await getNeighborActivity('aaa000002', 40.71, -74.01, DOW, HOUR);

  assert.strictEqual(rangeScans.length, 1,
    `a fresh place id bought a second bounding-box scan (${rangeScans.length} scans)`);
  // Neither id is in the corpus, so neither is subtracted: three NYC venues.
  assert.deepStrictEqual(a, b, 'two venues in one bucket disagreed about their own neighbourhood');
  assert.strictEqual(a.count, 3);
  assert.strictEqual(a.mean, 60); // (40 + 60 + 80) / 3
  assertModelled();
});

test('twenty unique place ids in one batch buy one range scan, not twenty', async () => {
  for (let i = 0; i < 20; i++) {
    await getNeighborActivity(`spoof-${i}`, 40.71, -74.01, DOW, HOUR);
  }
  assert.strictEqual(rangeScans.length, 1,
    `the audit's request shape still fans out: ${rangeScans.length} range scans for 20 items`);
  assertModelled();
});

test('coordinates that differ below the bucket share the entry', async () => {
  await getNeighborActivity('ChIJ_nyc_a', 40.7100, -74.0100, DOW, HOUR);
  await getNeighborActivity('ChIJ_nyc_b', 40.7104, -74.0102, DOW, HOUR);
  assert.strictEqual(rangeScans.length, 1, 'the fourth decimal place still bought a scan');
  assertModelled();
});

// ── 2. A different area is still a different answer ─────────────────────────

test('a genuinely different area still queries, and gets its own answer', async () => {
  const nyc = await getNeighborActivity('ChIJ_nyc_a', 40.7100, -74.0100, DOW, HOUR);
  const la = await getNeighborActivity('ChIJ_la_a', 34.0500, -118.2400, DOW, HOUR);

  assert.strictEqual(rangeScans.length, 2, 'Los Angeles was served Manhattan out of the cache');
  // NYC seen from venue a: three venues in the box, a itself removed.
  assert.strictEqual(nyc.count, 2);
  assert.strictEqual(nyc.mean, 70); // (60 + 80) / 2
  // LA has exactly one venue in its box, and it is the caller — so no
  // neighbours at all, which is the case that must NOT come back as
  // "one neighbour whose baseline happens to be my own".
  assert.deepStrictEqual(la, { count: 0, mean: 0 });
  assertModelled();
});

test('the second area does not evict the first — a repeat is still free', async () => {
  await getNeighborActivity('ChIJ_nyc_a', 40.7100, -74.0100, DOW, HOUR);
  await getNeighborActivity('ChIJ_la_a', 34.0500, -118.2400, DOW, HOUR);
  await getNeighborActivity('ChIJ_nyc_c', 40.7096, -74.0098, DOW, HOUR);
  assert.strictEqual(rangeScans.length, 2);
  assert.strictEqual(_internals.neighborCacheSize(), 2);
  assertModelled();
});

// ── 3. Self-exclusion survived, as arithmetic ───────────────────────────────

test('the venue is still excluded from its own neighbourhood', async () => {
  const fromA = await getNeighborActivity('ChIJ_nyc_a', 40.7100, -74.0100, DOW, HOUR);
  const fromB = await getNeighborActivity('ChIJ_nyc_b', 40.7104, -74.0102, DOW, HOUR);
  const fromC = await getNeighborActivity('ChIJ_nyc_c', 40.7096, -74.0098, DOW, HOUR);

  // One shared range scan; each venue subtracts itself from the shared totals.
  assert.strictEqual(rangeScans.length, 1);
  assert.deepStrictEqual(fromA, { count: 2, mean: 70 });  // (60 + 80) / 2
  assert.deepStrictEqual(fromB, { count: 2, mean: 60 });  // (40 + 80) / 2
  assert.deepStrictEqual(fromC, { count: 2, mean: 50 });  // (40 + 60) / 2
  assertModelled();
});

test('the self lookup is an index seek, cached per place, never a second range scan', async () => {
  await getNeighborActivity('ChIJ_nyc_a', 40.7100, -74.0100, DOW, HOUR);
  await getNeighborActivity('ChIJ_nyc_a', 40.7100, -74.0100, DOW, HOUR);
  assert.strictEqual(selfSeeks.length, 1, 'the self lookup re-queried for the same place');
  assert.strictEqual(rangeScans.length, 1);
  for (const q of selfSeeks) {
    assert.ok(!/BETWEEN/.test(q.sql), 'the self lookup became a range scan');
    assert.deepStrictEqual(q.params, ['ChIJ_nyc_a']);
  }
  assertModelled();
});

test('a place id that is not in the corpus subtracts nothing, and is not re-sought', async () => {
  const first = await getNeighborActivity('not-a-real-place', 40.71, -74.01, DOW, HOUR);
  const second = await getNeighborActivity('not-a-real-place', 40.71, -74.01, DOW, HOUR);
  assert.deepStrictEqual(first, { count: 3, mean: 60 });
  assert.deepStrictEqual(second, first);
  assert.strictEqual(selfSeeks.length, 1,
    'a fabricated place id re-queried on every prediction — the negative result must be cached too');
  assertModelled();
});

// ── 4. The key and the SQL, pinned against the source ───────────────────────

test('the range-scan SQL carries no place id, and the cache key is coordinates only', () => {
  // Normalised for line endings before anything is sliced out of it: this file
  // is CRLF in the repo and LF after most tooling touches it, and a slice that
  // silently misses turns this whole case into a pass on an empty string.
  const source = fs
    .readFileSync(path.join(__dirname, '..', 'services', 'mlPredictor.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  // The slice starts at scanNeighborBox, not at getNeighborActivity. R4-I2
  // split the range scan out into that helper so the budget gate could sit in
  // front of it, and a slice that started at getNeighborActivity would no
  // longer contain the SQL this case exists to pin — it would pass every
  // assertion below by looking at the wrong function.
  const start = source.indexOf('async function scanNeighborBox');
  assert.notStrictEqual(start, -1, 'scanNeighborBox is gone from mlPredictor.js');
  const end = source.indexOf('async function getNeighborActivity', start);
  assert.notStrictEqual(end, -1, 'getNeighborActivity is gone from mlPredictor.js');
  const fn = source.slice(end);
  const close = fn.indexOf('\n}\n');
  assert.notStrictEqual(close, -1, 'could not find the end of getNeighborActivity');
  // Both halves of the neighbour lookup: the scan and its caller.
  const body = source.slice(start, end) + fn.slice(0, close + 2);

  assert.ok(!/google_place_id != /.test(body),
    'the `!=` exclusion is back in the query, which puts the caller\'s place id in the cache key again');
  assert.match(body, /const key = `\$\{bLat\}_\$\{bLng\}`/,
    'the neighbour cache key must be the bucketed coordinates and nothing else');
  assert.ok(!/neighborCache\.get\([^)]*placeId/.test(body),
    'the cache is still being read with a place id in the key');

  // The one range scan in the file must take exactly two parameters, both
  // coordinates. (Any third would be the caller-chosen value coming back.)
  assert.match(body, /\[Number\(bLat\), Number\(bLng\), NEIGHBOR_BOX_DEG\]/,
    'the range scan must be parameterised on the bucketed coordinates and the box width');
});

test('the box width is one constant, shared by the scan and the self check', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'mlPredictor.js'), 'utf8');
  assert.match(source, /const NEIGHBOR_BOX_DEG = 0\.0075;/);
  // Two literal 0.0075s would let the box the totals were taken over and the
  // box the self check tests against drift apart — a venue could then be
  // subtracted from a box it was never counted in.
  const code = source.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
  const literals = code.match(/0\.0075/g) || [];
  assert.strictEqual(literals.length, 1,
    'the ~1 km box width is written more than once; it must be the one constant');
});

// ── 5. R4-I2: the bucket is the caller's number too ─────────────────────────
//
// Round 3 took `place_id` out of the key. Round 4's answer was that what
// replaced it — `lat.toFixed(3)_lng.toFixed(3)` — is just as much the caller's
// to pick: routes/crowd.js rounds the batch coordinates to 2 decimals, which
// still leaves ~648 million reachable buckets, so twenty DISTINCT coordinate
// pairs in one POST /api/crowd/batch were still twenty guaranteed range scans
// on no budget at all. Every case above holds ONE coordinate fixed and varies
// the place id, which is exactly why none of them caught it.
//
// The control can no longer be the cache, because no part of the key is
// server-derived. It is a per-account budget on the MISS.

const uid = (() => { let n = 900000; return () => ++n; })();

test('R4-I2: twenty DISTINCT buckets no longer buy twenty unmetered scans', async () => {
  // Un-metered (no userId, i.e. crowdAlerts and the public demo) this is
  // twenty range scans and always was — that is the finding, reproduced.
  for (let i = 0; i < 20; i++) {
    await getNeighborActivity('spoof-a', 40.71 + i * 0.01, -74.01, DOW, HOUR);
  }
  assert.strictEqual(rangeScans.length, 20,
    'fixture broken: twenty distinct buckets must genuinely miss');

  // Charged to an account, the same walk stops at that account's ceiling.
  _internals.__resetNeighborCaches();
  rangeScans = [];
  const attacker = uid();
  const walk = _internals.NEIGHBOR_USER_HOURLY + 50;
  for (let i = 0; i < walk; i++) {
    await getNeighborActivity('spoof-a', 40.71 + i * 0.01, -74.01, DOW, HOUR, attacker);
  }
  assert.strictEqual(rangeScans.length, _internals.NEIGHBOR_USER_HOURLY,
    `an account walked past its own ceiling: ${rangeScans.length} scans for ${walk} buckets`);
  assert.strictEqual(_internals.neighborBudgetRemaining(attacker).hourly, 0);
  assertModelled();
});

test('R4-I2: a refused miss runs no query AND writes no cache entry', async () => {
  const attacker = uid();
  for (let i = 0; i < _internals.NEIGHBOR_USER_HOURLY; i++) {
    await getNeighborActivity('spoof-a', 40.71 + i * 0.01, -74.01, DOW, HOUR, attacker);
  }
  const scansAtCeiling = rangeScans.length;
  const sizeAtCeiling = _internals.neighborCacheSize();

  const refused = await getNeighborActivity('spoof-a', 45.0, -80.0, DOW, HOUR, attacker);
  assert.deepStrictEqual(refused, { count: 0, mean: 0 },
    'a refused lookup must degrade to the same `none` every other failure path returns');
  assert.strictEqual(rangeScans.length, scansAtCeiling,
    'the refused caller still ran the range scan — the gate is on the wrong side of the query');
  // The eviction half of R4-I2: twenty fresh buckets a request against a
  // 2,000-entry FIFO churns real users' entries out, so a refused account must
  // also be unable to WRITE.
  assert.strictEqual(_internals.neighborCacheSize(), sizeAtCeiling,
    'a refused caller still wrote a cache entry, so it can still evict real users');
  assertModelled();
});

test('R4-I2: exhausting one account refuses neither another account nor the unmetered callers', async () => {
  const attacker = uid();
  for (let i = 0; i < _internals.NEIGHBOR_USER_HOURLY + 5; i++) {
    await getNeighborActivity('spoof-a', 40.71 + i * 0.01, -74.01, DOW, HOUR, attacker);
  }
  assert.strictEqual(_internals.neighborBudgetRemaining(attacker).hourly, 0);

  // Per-account, so this is not the global denial lever the Vision ceiling is.
  const victim = uid();
  const before = rangeScans.length;
  const got = await getNeighborActivity('ChIJ_la_a', 34.05, -118.24, DOW, HOUR, victim);
  assert.strictEqual(rangeScans.length, before + 1,
    'a second account was refused a scan the first account had spent');
  assert.deepStrictEqual(got, { count: 0, mean: 0 }); // LA holds only the caller

  // And the callers with no account at all keep the un-metered behaviour
  // allowEventFetch already grants them. `!allow(undefined)` would have
  // refused every one of them, because createUserBudget fails closed.
  const before2 = rangeScans.length;
  await getNeighborActivity('ChIJ_nyc_a', 41.9, -75.5, DOW, HOUR);
  assert.strictEqual(rangeScans.length, before2 + 1,
    'an unmetered caller (crowdAlerts, the public demo) was refused');
  assertModelled();
});

test('R4-I2: a supplied-but-malformed userId is refused, not waved through', async () => {
  const before = rangeScans.length;
  let n = 0;
  for (const bad of ['', 0, -1, 1.5, 'abc', true, [9], {}, NaN]) {
    n += 1;
    const got = await getNeighborActivity('spoof-a', 47.11 + n * 0.01, -87.01, DOW, HOUR, bad);
    assert.deepStrictEqual(got, { count: 0, mean: 0 }, `malformed id ${String(bad)} was served`);
  }
  assert.strictEqual(rangeScans.length, before,
    'a malformed userId bought an unmetered range scan — the free lane is back');
  assertModelled();
});

test('R4-I2: concurrent callers on one bucket coalesce into ONE scan and ONE charge', async () => {
  // routes/crowd.js scores its twenty venues in a Promise.all, so all twenty
  // reach the miss branch before any of them has written an entry. A cache is
  // a memory of a FINISHED query; without coalescing this stayed at twenty
  // scans no matter how well the key space collapsed.
  const user = uid();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => getNeighborActivity(`spoof-${i}`, 40.71, -74.01, DOW, HOUR, user))
  );
  assert.strictEqual(rangeScans.length, 1,
    `twenty simultaneous callers on one bucket ran ${rangeScans.length} scans`);
  assert.strictEqual(
    _internals.neighborBudgetRemaining(user).hourly,
    _internals.NEIGHBOR_USER_HOURLY - 1,
    'the nineteen coalesced followers were charged for a query nobody ran');
  for (const r of results) assert.deepStrictEqual(r, { count: 3, mean: 60 });
  assert.strictEqual(_internals.neighborInflightSize(), 0,
    'the in-flight map leaked a key, so that bucket is now permanently poisoned');
  assertModelled();
});

test('R4-I2: the ceilings are the ones the comment argues for', () => {
  assert.ok(_internals.NEIGHBOR_USER_DAILY > _internals.NEIGHBOR_USER_HOURLY,
    'a daily ceiling at or below the hourly one makes the hourly limit dead code');
  // The unit is one uncached ~1 km bucket, not a request and not a venue.
  assert.strictEqual(_internals.NEIGHBOR_USER_HOURLY, 120);
  assert.strictEqual(_internals.NEIGHBOR_USER_DAILY, 400);
});

test('R4-I2: the budget gate sits in FRONT of the query, pinned against the source', () => {
  const source = fs
    .readFileSync(path.join(__dirname, '..', 'services', 'mlPredictor.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const start = source.indexOf('async function scanNeighborBox');
  const end = source.indexOf('async function getNeighborActivity', start);
  assert.ok(start !== -1 && end > start, 'scanNeighborBox is gone from mlPredictor.js');
  const scan = source.slice(start, end);

  const gate = scan.indexOf('neighborUserBudget.allow');
  const q = scan.indexOf('pool.query');
  assert.notStrictEqual(gate, -1, 'the neighbour range scan lost its budget gate');
  assert.ok(gate < q,
    'the budget is charged AFTER the range scan, so the scan it exists to prevent still runs');

  // The optional-identity contract. `!allow(undefined)` refuses every
  // background producer and the whole unauthenticated demo, because
  // createUserBudget.allow fails closed on anything that is not an id.
  assert.match(scan, /userId != null && !neighborUserBudget\.allow\(userId\)/,
    'the identity guard must be `userId != null && !allow(userId)`, matching allowEventFetch');
});
