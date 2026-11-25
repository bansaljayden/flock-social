'use strict';
// ---------------------------------------------------------------------------
// scripts/ml/train/importFilterCache.js and harvestVenueFilter's --offline.
//
// The filter cache is all that is left of BestTime (the subscription ended on
// 2026-11-25), and its rows are meant to train. What is pinned, and why:
//   * --offline never reaches the network (fetch is stubbed to throw, and a
//     run that tried would abort), reads no key status, counts a question
//     the cache lacks as an empty box, and refuses a commit whose misses are
//     not the 404s the filling run recorded;
//   * the import replays a city from its folder alone, around the plan's own
//     centroid, and refuses a city whose files are not all read, whose misses
//     are not progress.json's notFound (a partial city), that the plan marks
//     config:true or whose key is a holdout, beijing or a training city (those
//     folders are never opened);
//   * one global placement: a venue nearer a training city or a holdout is
//     dropped, one inside two cities' circles is one venue;
//   * with an identity snapshot, a venue ml_venues holds is dropped, and so is
//     one within 2 km of any ml_venues row; without one, both are "pending";
//   * the rows: the export's 48-column HEADER, city world_cache, synthetic ids
//     from 1,000,000,000, no Google types or price, month 11 and fall, the
//     venue's own value as its baseline, rating as NUMERIC(2,1) stores it;
//     the sidecar and the manifest's SHA-256s;
//   * the peak-hour check flags a city whose bar mode moves 3 h or more from
//     the training cities', and --write leaves it out unless named;
//   * END TO END: fixture answers written by the harvester's own --offline
//     --commit into a real migrated Postgres, exported by the real exporter,
//     and --parity finds every exported row equal to the generator's.
//
// HOW TO RUN
//   cd backend && node --test __tests__/importFilterCache.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

// Synchronous, before the requires below: scripts/ml/* call dotenv on
// backend/.env, and only a variable already set keeps them off it.
const PG_PORT = pickEmbeddedPgPort('importFilterCache');
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_import_cache_test`;
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';
process.env.BESTTIME_API_KEY = 'pri_not_a_real_key_for_import_tests';
process.env.BESTTIME_API_KEY_PUBLIC = 'pub_not_a_real_key_for_import_tests';

const { migrate } = require('../db/migrate');
const H = require('../scripts/ml/harvestVenueFilter');
const I = require('../scripts/ml/train/importFilterCache');
const exporter = require('../scripts/ml/train/export_training_data');
const { bestTimeSlotToLocal } = require('../scripts/ml/collectWeekly');
const { bestTimeDayToJsDay, VENUE_TARGETS } = require('../scripts/ml/config');

// Not a key: the fake never checks it, and the cache files hold none.
const FIXTURE_KEY = 'pri_fixturefixturefixture';
const FETCHED_AT = '2026-11-24T12:00:00.000Z';
const HEADER_FIELDS = exporter.HEADER.split(',');
const col = (name) => HEADER_FIELDS.indexOf(name);

const tmpRoots = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Fixture weeks and venues.
// ---------------------------------------------------------------------------
// BestTime day d slot s reads (seed + 24d + s) % 101: neighbouring cells
// differ, so a shifted row cannot pass by coincidence.
const weekFor = (seed) => Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, s) => (seed + 24 * d + s) % 101));
// Every day busiest at venue-local `hour` (slot s is hour (s + 6) % 24).
const peakWeek = (hour) => Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, s) => ((s + 6) % 24 === hour ? 80 : 10)));

function vn(id, lat, lng, type, placeId, week, extra = {}) {
  return { id, lat, lng, type, placeId, week, name: `Venue ${id}`, rating: 4.4, reviews: 120, ...extra };
}

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function record(v, day) {
  const rec = {
    venue_id: v.id, venue_name: v.name, venue_address: '1 Test St', venue_lat: v.lat, venue_lng: v.lng,
    venue_type: v.type, day_int: day, day_info: { day_int: day }, day_raw_whole: v.week[day],
    rating: v.rating, reviews: v.reviews, price_level: 2,
  };
  if (v.placeId) rec.place_id = v.placeId;
  return rec;
}

// A fake Venue Filter answering by box, day and page; `notFoundWhen` makes a
// question 404, which the harvest (and the cacher) never cache.
function fakeFilter(venues, { notFoundWhen = () => false } = {}) {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/v1/venues/filter') return jsonResponse(404, {});
    const p = url.searchParams;
    const day = Number(p.get('day_int'));
    const box = { s: Number(p.get('lat_min')), n: Number(p.get('lat_max')), w: Number(p.get('lng_min')), e: Number(p.get('lng_max')) };
    const page = Number(p.get('page'));
    const limit = Number(p.get('limit'));
    const inBox = venues.filter((v) => v.lat >= box.s && v.lat <= box.n && v.lng >= box.w && v.lng <= box.e);
    if (notFoundWhen({ day, box, page, inBox })) return jsonResponse(404, {});
    const slice = inBox.slice(page * limit, page * limit + limit);
    return jsonResponse(200, { status: 'OK', venues: slice.map((v) => record(v, day)), venues_n: slice.length });
  };
}

// Fills `dir` the way the cacher did: the harvester's own questions, asked
// online against the fake with --cache-dir, every answer kept. Returns the
// 404 count, which is what progress.json records as notFound.
async function fillCache(dir, { cities, radiusKm, centroids = null, venues, notFoundWhen }) {
  fs.mkdirSync(dir, { recursive: true });
  const opts = {
    cacheDir: dir, offline: false, cities, days: [0, 1, 2, 3, 4, 5, 6], tileKm: 20, radiusKm, resultCap: 500, pageSize: 100,
    allTypes: false, askPlaceId: true, maxRequests: 1e9, resultBudget: 1e12,
  };
  const tilePlan = centroids ? H.planTiles(cities, 20, radiusKm, centroids) : H.planTiles(cities, 20, radiusKm);
  const ctx = {
    key: FIXTURE_KEY, opts, stats: H.emptyStats(), sleep: async () => {}, pace: async () => {},
    city: H.emptyCityStats(tilePlan.length), area: null, dayTally: new Map(), otherDays: new Map(), secrets: [FIXTURE_KEY],
    centroids: centroids || undefined, quiet: true,
  };
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFilter(venues, { notFoundWhen });
  try {
    for (const { area, tile } of tilePlan) {
      ctx.area = area;
      await H.harvestBox(ctx, tile, new Map());
    }
  } finally {
    globalThis.fetch = saved;
  }
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.fetchedAt = FETCHED_AT;
    fs.writeFileSync(file, JSON.stringify(entry));
  }
  return { notFound: ctx.stats.notFound, files: fs.readdirSync(dir).length };
}

const progressRecord = (c, notFound, state = 'done') => ({
  name: c.key, lat: c.lat, lon: c.lon, radiusKm: c.radiusKm, config: false, note: '', dir: `${c.key}-2026-11-r${c.radiusKm}`,
  state, notFound, refusedQuestions: 0, oddAnswers: 0, otherDay: 0, truncated: 0,
});

// ---------------------------------------------------------------------------
// The fixture cache: a plan, its progress, its folders, a training reference.
// ---------------------------------------------------------------------------
const C = {
  testville: { key: 'testville', lat: 10.0, lon: 10.0, radiusKm: 10 },
  twintown: { key: 'twintown', lat: 10.0, lon: 10.16, radiusKm: 10 },
  nearphilly: { key: 'nearphilly', lat: 40.05, lon: -75.0, radiusKm: 10 },
  nearmiami: { key: 'nearmiami', lat: 25.86, lon: -80.36, radiusKm: 12 },
  partialtown: { key: 'partialtown', lat: 12.0, lon: 12.0, radiusKm: 10 },
  missytown: { key: 'missytown', lat: 14.0, lon: 14.0, radiusKm: 10 },
  extratown: { key: 'extratown', lat: 16.0, lon: 16.0, radiusKm: 10 },
};
const T = {
  bar: vn('ven_t_a_bar', 10.0, 10.0, 'BAR', 'ChIJtestvilleBarA00001', peakWeek(18), { name: 'Copper Kettle' }),
  // Its twin, 15 m off under a similar name and a higher BestTime id.
  twin: vn('ven_t_b_twin', 10.0001, 10.0001, 'BAR', 'ChIJtestvilleBarTwin01', peakWeek(18), { name: 'Copper Kettle Bar' }),
  restaurant: vn('ven_t_c_rest', 10.0, 10.04, 'RESTAURANT', 'ChIJtestvilleRestC0001', weekFor(3), { rating: 4.35, reviews: 120 }),
  cafe: vn('ven_t_d_cafe', 10.04, 10.0, 'CAFE', 'ChIJtestvilleCafeD0001', weekFor(9), { rating: 4, reviews: 0 }),
  noPlace: vn('ven_t_e_noplace', 10.04, 10.04, 'RESTAURANT', null, weekFor(15)),
  far: vn('ven_t_f_far', 9.915, 9.915, 'RESTAURANT', 'ChIJtestvilleFarF00001', weekFor(21)),
  noName: vn('ven_t_g_noname', 10.02, 10.02, 'RESTAURANT', 'ChIJtestvilleNoNameG01', weekFor(27), { name: '' }),
  knownBt: vn('ven_t_h_knownbt', 9.96, 10.0, 'RESTAURANT', 'ChIJtestvilleKnownBtH1', weekFor(33)),
  knownPlace: vn('ven_t_i_knownpl', 10.0, 9.96, 'RESTAURANT', 'ChIJtestvilleKnownPlI1', weekFor(39)),
  near: vn('ven_t_j_near', 9.96, 10.04, 'RESTAURANT', 'ChIJtestvilleNearJ0001', weekFor(45)),
  // Inside both testville's and twintown's boxes, nearer testville.
  shared: vn('ven_t_k_shared', 10.0, 10.075, 'RESTAURANT', 'ChIJtestvilleSharedK01', weekFor(51)),
};
const W = { bar: vn('ven_w_a_bar', 10.0, 10.2, 'BAR', 'ChIJtwintownBarA00001', peakWeek(22)) };
const NP = { venue: vn('ven_np_a', 40.05, -75.0, 'BAR', 'ChIJnearphillyA000001', weekFor(57)) };
const NM = {
  holdout: vn('ven_nm_a_holdout', 25.80, -80.25, 'BAR', 'ChIJnearmiamiHoldout01', weekFor(63)),
  club: vn('ven_nm_b_club', 25.87, -80.37, 'CLUBS', 'ChIJnearmiamiClubB0001', peakWeek(1)),
};
const PT = { venue: vn('ven_pt_a', 12.0, 12.0, 'BAR', 'ChIJpartialtownA00001', weekFor(69)) };
const MT = { venue: vn('ven_mt_a', 14.0, 14.0, 'BAR', 'ChIJmissytownA0000001', weekFor(75)) };
const XT = { venue: vn('ven_xt_a', 16.0, 16.0, 'BAR', 'ChIJextratownA0000001', weekFor(81)) };

let root;
let planFile;
let refDir;
let snapshotFile;
const plan = [
  { key: 'miami', config: true, radiusKm: 40, note: 'HOLDOUT city' },
  ...Object.values(C).map((c) => ({ key: c.key, name: c.key, lat: c.lat, lon: c.lon, radiusKm: c.radiusKm })),
  { key: 'tokyo', name: 'Tokyo, not marked config', lat: 35.6762, lon: 139.6503, radiusKm: 20 },
  { key: 'unreachedville', name: 'never cached', lat: 18.0, lon: 18.0, radiusKm: 10 },
];

async function buildFixture() {
  root = tmp('flock-import-cache-');
  const progress = { cities: {} };
  const one = async (c, venues, opts = {}) => {
    const dir = path.join(root, `${c.key}-2026-11-r${c.radiusKm}`);
    const centroids = { [c.key]: { lat: c.lat, lon: c.lon } };
    const r = await fillCache(dir, { cities: [c.key], radiusKm: c.radiusKm, centroids, venues, notFoundWhen: opts.notFoundWhen });
    progress.cities[c.key] = progressRecord(c, opts.recordNotFound ?? r.notFound, opts.state);
    return { dir, ...r };
  };
  // testville 404s one empty question, so its misses are real and recorded.
  const emptyDay3 = ({ day, inBox, page }) => day === 3 && page === 0 && inBox.length === 0;
  const tv = await one(C.testville, Object.values(T), { notFoundWhen: emptyDay3 });
  assert.ok(tv.notFound >= 0);
  await one(C.twintown, [W.bar, T.shared]);
  await one(C.nearphilly, [NP.venue]);
  await one(C.nearmiami, [NM.holdout, NM.club]);
  // partialtown: stopped by the cacher, and one question it never answered.
  await one(C.partialtown, [PT.venue], { state: 'stopped', recordNotFound: 0, notFoundWhen: ({ day, page }) => day === 5 && page === 0 });
  // missytown: a cache file lost after the fact, so misses exceed notFound.
  const mt = await one(C.missytown, [MT.venue]);
  fs.unlinkSync(path.join(mt.dir, fs.readdirSync(mt.dir)[0]));
  // extratown: one answer no question of the replay asks.
  const xt = await one(C.extratown, [XT.venue]);
  const stray = 'https://besttime.app/api/v1/venues/filter?lat_min=1.000&page=99';
  fs.writeFileSync(path.join(xt.dir, H.cacheFileName(stray)), JSON.stringify({ url: stray, fetchedAt: FETCHED_AT, data: { venues: [] } }));
  // The holdout's folder holds something no reader could parse: opening it at
  // all would show.
  fs.mkdirSync(path.join(root, 'miami-2026-11-r40'));
  fs.writeFileSync(path.join(root, 'miami-2026-11-r40', `${'0'.repeat(64)}.json`), 'not json');
  progress.cities.miami = { ...progressRecord({ key: 'miami', lat: 25.7617, lon: -80.1918, radiusKm: 40 }, 0), config: true };
  fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify(progress));
  planFile = path.join(root, 'cities.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));

  // The training reference: philly bars at 22h, nightclubs at 23h,
  // restaurants at 19h; one answer file per day.
  refDir = tmp('flock-import-ref-');
  const run = path.join(refDir, 'philly-2026-11');
  fs.mkdirSync(run);
  const ref = [
    ...Array.from({ length: 30 }, (_, i) => vn(`ven_ref_bar_${i}`, 39.95 + i * 0.001, -75.16, 'BAR', null, peakWeek(22))),
    ...Array.from({ length: 10 }, (_, i) => vn(`ven_ref_club_${i}`, 39.94 + i * 0.001, -75.15, 'CLUBS', null, peakWeek(23))),
    ...Array.from({ length: 20 }, (_, i) => vn(`ven_ref_rest_${i}`, 39.93 + i * 0.001, -75.14, 'RESTAURANT', null, peakWeek(19))),
  ];
  for (let d = 0; d < 7; d++) {
    const name = `${crypto.createHash('sha256').update(`ref-${d}`).digest('hex')}.json`;
    fs.writeFileSync(path.join(run, name), JSON.stringify({ url: `ref-${d}`, fetchedAt: FETCHED_AT, data: { venues: ref.map((v) => record(v, d)) } }));
  }

  // The identity snapshot (plan step C.4's columns, and besttime_status).
  snapshotFile = path.join(root, 'ml_venues_snapshot.csv');
  fs.writeFileSync(snapshotFile, [
    'id,besttime_venue_id,google_place_id,name,latitude,longitude,city,besttime_status',
    '101,ven_t_h_knownbt,ChIJsnapshotKnownBt001,Known Bt Row,9.96,10.0,philly,',
    '102,,ChIJtestvilleKnownPlI1,"Joe\'s ""Place"", Inc",10.0,9.96,philly,found',
    // 1.5 km north of ven_t_j_near, nobody's identity.
    '103,ven_unrelated,ChIJsnapshotUnrelated1,Unrelated Row,9.9735,10.04,philly,harvested',
    // 2.5 km north of ven_t_d_cafe: outside the 2 km rule.
    '104,ven_far_row,ChIJsnapshotFarRow0001,Far Row,10.0625,10.0,philly,',
    '',
  ].join('\n'));
}

async function runImport(args) {
  const lines = [];
  const result = await I.run(['node', 'importFilterCache.js', ...args], { log: (m) => lines.push(String(m)) });
  return { result, out: lines.join('\n') };
}

const baseArgs = () => [`--cache-root=${root}`, `--plan=${planFile}`];

// ---------------------------------------------------------------------------
// Postgres, for the --offline harvest and the parity proof.
// ---------------------------------------------------------------------------
let pg;
let pool;
let roPool;
let dataDir;

test.before(async () => {
  await buildFixture();
  dataDir = path.join(os.tmpdir(), `flock-import-cache-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'importFilterCache', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_import_cache_test');
  pool = new Pool({ connectionString: CONN });
  await migrate(pool);
  roPool = new Pool({ connectionString: CONN, options: '-c default_transaction_read_only=on' });
});

test.after(async () => {
  await roPool?.end().catch(() => {});
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'importFilterCache');
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the OS */ }
  }
});

// ---------------------------------------------------------------------------
// Pure pieces.
// ---------------------------------------------------------------------------
test('rating is written as NUMERIC(2,1) stores the number node-pg sends', () => {
  const cases = [[4, '4.0'], [4.35, '4.4'], [4.25, '4.3'], [4.349, '4.3'], [3.9, '3.9'], [5, '5.0'], [0.05, '0.1'],
    [4.44, '4.4'], [4.45, '4.5'], [1.15, '1.2'], [null, null], [undefined, null]];
  for (const [x, want] of cases) assert.equal(I.numeric21(x), want, String(x));
});

test('the month is the one every zone was in at every fetchedAt, or none', () => {
  const ms = (s) => Date.parse(s);
  assert.equal(I.monthAcrossZones(ms('2026-11-23T00:00:00Z'), ms('2026-11-25T23:59:00Z')), 11);
  // Kiritimati (+14) was in December already.
  assert.equal(I.monthAcrossZones(ms('2026-11-24T00:00:00Z'), ms('2026-11-30T12:00:00Z')), null);
  // Baker Island (-12) was still in October.
  assert.equal(I.monthAcrossZones(ms('2026-11-01T06:00:00Z'), ms('2026-11-02T00:00:00Z')), null);
});

test('the reference peak is harvestVenueFilter.peakHourHistogram\'s, and shifts are read on the clock face', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 200; k++) {
    const days = [0, 1, 2, 3, 4, 5, 6].filter(() => rand() < 0.8)
      .map((d) => [d, Array.from({ length: 24 }, () => (rand() < 0.1 ? null : Math.floor(rand() * 101)))]);
    const cells = H.weekCells(days);
    const sum = new Float64Array(24);
    const cnt = new Uint16Array(24);
    for (const c of cells) { sum[c.hour] += c.busyness; cnt[c.hour]++; }
    const hist = H.peakHourHistogram([{ category: 'bar', cells }]);
    const want = hist.has('bar') ? hist.get('bar').indexOf(1) : -1;
    assert.equal(I.peakFromSums(sum, cnt), want, `trial ${k}`);
  }
  assert.equal(I.hourShift(22, 18), -4);
  assert.equal(I.hourShift(23, 1), 2);
  assert.equal(I.hourShift(22, 10), 12);
  assert.equal(I.hourShift(1, 23), -2);
});

test('the cache\'s categories are the export\'s categories, so the category encoding cannot grow', () => {
  const corpus = new Set(VENUE_TARGETS.map((t) => t.category));
  for (const category of new Set(Object.values(H.TYPE_TO_CATEGORY))) assert.ok(corpus.has(category), category);
});

test('a CSV field may hold commas, doubled quotes and line breaks', () => {
  assert.deepEqual(I.parseCsv('a,b,c\n1,"x, ""y""\nz",\r\n'), [['a', 'b', 'c'], ['1', 'x, "y"\nz', '']]);
  assert.throws(() => I.parseCsv('a,"b\n'), /never closes/);
});

test('a weekly row is the export\'s 48 columns, field for field', () => {
  const venue = { venueId: 'ven_x', lat: 10.123456789012345, lng: -9.5, rating: 4.35, reviews: 7, days: new Map() };
  const line = exporter.rowToCsv(I.weeklyRow({ venue, category: 'bar', month: 11 },
    { dayOfWeek: 5, hour: 22, busyness: 63 }, { venueId: 1000000007, city: I.WORLD_CACHE_CITY }));
  const want = [1000000007, 5, 22, 11, 'fall', 0, 0, 'bar', '', '4.4', 7, ...Array(17).fill(''), 63, 0, 63, 'world_cache',
    '', '', '', 10.123456789012345, -9.5, 0, 0, 0, '', 'weekly', '', '', 0, '', '', ''].join(',');
  assert.equal(line, want);
  assert.equal(line.split(',').length, 48);
  assert.equal(HEADER_FIELDS.length, 48);
});

test('the arguments refuse what would make an import unsafe', () => {
  const p = (...a) => I.parseImportArgs(['node', 'x', ...a]);
  assert.match(p().error, /exactly one/);
  assert.match(p('--dry-run', '--write', '--cache-root=a', '--plan=b').error, /exactly one/);
  assert.match(p('--dry-run').error, /--cache-root and --plan/);
  assert.match(p('--write', '--cache-root=a', '--plan=b', '--out-dir=o', '--harvest-cache=h').error, /--identity-snapshot/);
  assert.match(p('--write', '--cache-root=a', '--plan=b', '--out-dir=o', '--identity-snapshot=s').error, /--harvest-cache/);
  assert.match(p('--write', '--cache-root=a', '--plan=b', '--out-dir=o', '--identity-snapshot=s', '--harvest-cache=h', '--only=x').error, /--only/);
  assert.match(p('--dry-run', '--cache-root=a', '--plan=b', '--accept-peak-flags=x').error, /--write/);
  assert.match(p('--parity', '--cache-dir=a', '--identity-snapshot=s', '--export-csv=e', '--cities=miami', '--radius-km=20').error, /training-city/);
  assert.match(p('--parity', '--cache-dir=a', '--identity-snapshot=s', '--export-csv=e', '--cities=philly').error, /--radius-km/);
  assert.match(p('--dry-run', '--cache-root=a', '--plan=b', '--bogus').error, /Unknown/);
  assert.equal(p('--dry-run', '--cache-root=a', '--plan=b').progress, path.join(path.resolve('a'), 'progress.json'));
  // A harvest-cache run folder names its run; --parity reads it, and refuses
  // a scope that disagrees with it.
  assert.deepEqual(I.runFolderScope('denver,seattle,chicago,la-2026-11'), { cities: ['denver', 'seattle', 'chicago', 'la'], radiusKm: 20 });
  assert.deepEqual(I.runFolderScope('philly+lehigh-2026-11-r40'), { cities: ['philly', 'lehigh'], radiusKm: 40 });
  assert.equal(I.runFolderScope('notes'), null);
  const inferred = p('--parity', '--cache-dir=x/nyc-2026-11-r40', '--identity-snapshot=s', '--export-csv=e');
  assert.deepEqual([inferred.cities, inferred.radiusKm], [['nyc'], 40]);
  assert.match(p('--parity', '--cache-dir=x/nyc-2026-11-r40', '--identity-snapshot=s', '--export-csv=e', '--radius-km=20').error,
    /would ask other questions/);
});

// ---------------------------------------------------------------------------
// The dry run over the fixture cache.
// ---------------------------------------------------------------------------
test('a dry run refuses holdout, config, partial and incomplete cities, and never opens a holdout folder', async () => {
  const { result, out } = await runImport(['--dry-run', ...baseArgs()]);
  assert.equal(result.exitCode, 0, out);
  const c = result.report.cities;
  assert.deepEqual(c.miami.reasons.map((r) => r.reason), ['configCity']);
  assert.equal(c.miami.opened, false);
  assert.match(out, /Folders never opened: miami-2026-11-r40/);
  assert.deepEqual(c.tokyo.reasons.map((r) => r.reason), ['refusedCity']);
  assert.equal(c.tokyo.opened, false);
  // The partial city: stopped, and a question it never answered.
  assert.deepEqual(c.partialtown.reasons.map((r) => r.reason).sort(), ['cacherNotDone', 'missesNotNotFound']);
  assert.equal(c.partialtown.misses, 1);
  assert.equal(c.partialtown.notFound, 0);
  // A lost file is a miss that was not a 404.
  assert.deepEqual(c.missytown.reasons.map((r) => r.reason), ['missesNotNotFound']);
  assert.equal(c.missytown.misses, c.missytown.notFound + 1);
  // An answer the replay never asks for.
  assert.deepEqual(c.extratown.reasons.map((r) => r.reason), ['unusedFiles']);
  assert.equal(c.extratown.filesRead, c.extratown.filesHeld - 1);
  assert.equal(c.unreachedville, undefined, 'a city the cacher never reached is neither accepted nor refused');
  assert.equal(result.report.totals.unreached, 1);
  for (const key of ['testville', 'twintown', 'nearphilly', 'nearmiami']) {
    assert.equal(c[key].state, 'accepted', key);
    assert.equal(c[key].filesRead, c[key].filesHeld, `${key} left a file unread`);
    assert.equal(c[key].misses, c[key].notFound, key);
  }
  assert.equal(result.report.totals.accepted, 4);
});

test('one global placement: training-city and holdout venues are dropped, a venue in two circles counts once', async () => {
  const { result } = await runImport(['--dry-run', ...baseArgs()]);
  const c = result.report.cities;
  const t = result.report.totals;
  assert.deepEqual(c.nearphilly.drops, { placedInTrainingCity: 1 });
  assert.equal(c.nearphilly.kept, 0);
  assert.deepEqual(t.placedInTrainingCity, { philly: 1 });
  assert.deepEqual(c.nearmiami.drops, { placedInHoldoutCity: 1 });
  assert.equal(c.nearmiami.kept, 1);
  assert.equal(t.keptWithin80kmOfAHoldout, 1);
  // The shared venue was found by both replays and is testville's alone.
  assert.equal(t.venuesInTwoCircles, 1);
  assert.equal(c.twintown.venuesFound, 2);
  assert.equal(c.twintown.homeVenues, 1);
  assert.equal(c.twintown.kept, 1);
  const kept = result.kept.map((k) => k.venue.venueId).sort();
  assert.ok(kept.includes(T.shared.id));
  assert.equal(kept.filter((id) => id === T.shared.id).length, 1);
  // testville before the snapshot: the harvest's own new-venue rules only.
  assert.deepEqual(c.testville.drops, { outsideRadius: 1, noPlaceId: 1, noName: 1, nearDuplicateInRun: 1 });
  assert.equal(c.testville.kept, 7);
  assert.equal(t.identityRules, 'pending snapshot');
  assert.equal(t.keepAwayRule, 'pending snapshot');
  assert.equal(t.distinctVenues, t.kept + Object.values(t.drops).reduce((a, b) => a + b, 0));
});

test('with the snapshot, a venue the corpus holds and one within 2 km of a corpus venue are dropped', async () => {
  const { result, out } = await runImport(['--dry-run', ...baseArgs(), `--identity-snapshot=${snapshotFile}`]);
  assert.equal(result.exitCode, 0, out);
  const d = result.report.cities.testville.drops;
  assert.equal(d.knownByBesttimeId, 1);
  assert.equal(d.knownByPlaceId, 1);
  assert.equal(d.within2kmOfCorpusVenue, 1);
  const kept = new Set(result.kept.map((k) => k.venue.venueId));
  for (const v of [T.knownBt, T.knownPlace, T.near]) assert.ok(!kept.has(v.id), v.id);
  // 2.5 km from a corpus row is kept.
  assert.ok(kept.has(T.cafe.id));
  assert.equal(result.report.totals.identityRules, 'applied');
  assert.match(out, /4 ml_venues rows/);
});

test('the peak-hour check flags a city whose bar mode moves 3 hours or more, and only that', async () => {
  const { result, out } = await runImport(['--dry-run', ...baseArgs(), `--harvest-cache=${refDir}`]);
  assert.equal(result.exitCode, 0, out);
  assert.deepEqual(result.flagged, ['testville']);
  const p = result.report.cities.testville.peaks;
  assert.deepEqual([p.bar.mode, p.bar.reference, p.bar.shift, p.bar.flag], [18, 22, -4, true]);
  const club = result.report.cities.nearmiami.peaks.nightclub;
  assert.deepEqual([club.mode, club.reference, club.shift, club.flag], [1, 23, 2, false]);
  assert.equal(result.report.cities.twintown.peakFlag, false);
  assert.match(out, /PEAK FLAGS \(1/);
});

// ---------------------------------------------------------------------------
// --write.
// ---------------------------------------------------------------------------
test('--write writes the export\'s rows under world_cache, a sidecar and a manifest, leaving flagged cities out', async () => {
  const outDir = tmp('flock-import-out-');
  const args = ['--write', ...baseArgs(), `--identity-snapshot=${snapshotFile}`, `--harvest-cache=${refDir}`, `--out-dir=${outDir}`];
  const { result, out } = await runImport(args);
  assert.equal(result.exitCode, 0, out);
  assert.deepEqual(result.manifest.rules.refusedForPeakFlags, ['testville']);
  const sidecar = I.parseCsv(fs.readFileSync(path.join(outDir, 'cache_venues.csv'), 'utf8')).filter((r) => r.length > 1);
  assert.deepEqual(sidecar.slice(1).map((r) => [r[0], r[1], r[2]]), [
    ['1000000000', 'nearmiami', NM.club.id],
    ['1000000001', 'twintown', W.bar.id],
  ]);
  // A second write into the same folder is refused, and so is accepting a
  // city that was never flagged.
  const again = await runImport(args);
  assert.equal(again.result.exitCode, 1);
  assert.match(again.out, /already holds cache_rows\.csv/);
  const wrongAccept = await runImport([...args.slice(0, -1), `--out-dir=${tmp('flock-import-out-')}`, '--accept-peak-flags=twintown']);
  assert.equal(wrongAccept.result.exitCode, 1);
  assert.match(wrongAccept.out, /not flagged: twintown/);
});

test('--write with the flag accepted: every row is the export\'s, ids from 1,000,000,000, hashes in the manifest', async () => {
  const outDir = tmp('flock-import-out-');
  const { result, out } = await runImport(['--write', ...baseArgs(), `--identity-snapshot=${snapshotFile}`,
    `--harvest-cache=${refDir}`, `--out-dir=${outDir}`, '--accept-peak-flags=testville']);
  assert.equal(result.exitCode, 0, out);
  const rowsFile = path.join(outDir, 'cache_rows.csv');
  const text = fs.readFileSync(rowsFile, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines[0], exporter.HEADER);
  const rows = lines.slice(1).map((l) => I.parseCsv(l)[0]);
  const sidecar = I.parseCsv(fs.readFileSync(path.join(outDir, 'cache_venues.csv'), 'utf8')).filter((r) => r.length > 1).slice(1);
  // nearmiami, then testville's four by BestTime id, then twintown.
  assert.deepEqual(sidecar.map((r) => [Number(r[0]), r[1], r[2]]), [
    [1000000000, 'nearmiami', NM.club.id],
    [1000000001, 'testville', T.bar.id],
    [1000000002, 'testville', T.restaurant.id],
    [1000000003, 'testville', T.cafe.id],
    [1000000004, 'testville', T.shared.id],
    [1000000005, 'twintown', W.bar.id],
  ]);
  assert.equal(sidecar.find((r) => r[2] === T.restaurant.id)[3], T.restaurant.placeId);
  const ids = new Set();
  let prev = -1;
  for (const r of rows) {
    assert.equal(r.length, 48);
    const key = Number(r[col('venue_id')]) * 168 + Number(r[col('day_of_week')]) * 24 + Number(r[col('hour')]);
    assert.ok(key > prev, 'rows out of venue, day, hour order');
    prev = key;
    ids.add(Number(r[col('venue_id')]));
    assert.equal(r[col('city')], 'world_cache');
    for (const name of ['google_type_1', 'google_type_2', 'google_type_3', 'price_level', 'temperature', 'event_nearby',
      'has_nearby_event', 'observed_date', 'label_source', 'vendor_forecast_pct', 'live_hour_start']) {
      assert.equal(r[col(name)], '', name);
    }
    assert.deepEqual([r[col('month')], r[col('season')]], ['11', 'fall']);
    assert.equal(r[col('baseline_busyness')], r[col('busyness_pct')]);
    assert.deepEqual([r[col('is_realtime')], r[col('is_holiday')], r[col('is_school_break')], r[col('events_observed')]], ['0', '0', '0', '0']);
    assert.equal(r[col('label_provenance')], 'weekly');
    assert.deepEqual([r[col('avg_user_crowd')], r[col('user_feedback_count')], r[col('avg_prediction_error')]], ['0', '0', '0']);
  }
  assert.deepEqual([...ids].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5].map((n) => 1000000000 + n));
  const of = (id) => rows.filter((r) => r[col('venue_id')] === String(id));
  assert.equal(of(1000000001).length, 168);
  assert.deepEqual([of(1000000002)[0][col('rating')], of(1000000002)[0][col('review_count')]], ['4.4', '120']);
  assert.deepEqual([of(1000000003)[0][col('rating')], of(1000000003)[0][col('review_count')]], ['4.0', '']);
  assert.equal(of(1000000005)[0][col('venue_category')], 'bar');
  // Monday 6 AM is BestTime Monday slot 0.
  const cafeMon6 = of(1000000003).find((r) => r[col('day_of_week')] === '1' && r[col('hour')] === '6');
  assert.equal(Number(cafeMon6[col('busyness_pct')]), T.cafe.week[0][0]);
  const local = bestTimeSlotToLocal(20, bestTimeDayToJsDay(5));
  const cafeSat20 = of(1000000003).find((r) => r[col('day_of_week')] === String(local.dayOfWeek) && r[col('hour')] === String(local.hour));
  assert.equal(Number(cafeSat20[col('busyness_pct')]), T.cafe.week[5][20]);
  // The manifest's hashes are the files'.
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'cache_manifest.json'), 'utf8'));
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.equal(manifest.outputs.rows.sha256, sha(rowsFile));
  assert.equal(manifest.outputs.venues.sha256, sha(path.join(outDir, 'cache_venues.csv')));
  assert.equal(manifest.outputs.rows.dataRows, rows.length);
  assert.equal(manifest.inputs.identitySnapshot.sha256, sha(snapshotFile));
  assert.equal(manifest.inputs.plan.sha256, sha(planFile));
  assert.ok(manifest.git.commit === null || /^[0-9a-f]{40}$/.test(manifest.git.commit), String(manifest.git.commit));
  assert.deepEqual(manifest.outputs.syntheticIds, { first: 1000000000, last: 1000000005 });
});

// ---------------------------------------------------------------------------
// harvestVenueFilter --offline, and the parity proof against the real export.
// ---------------------------------------------------------------------------
// Twenty-four venues the corpus holds by BestTime id, with the weekly rows
// collectWeekly would have stored: the axis proof's evidence, as in
// harvestVenueFilter.test.js. Two new ones the offline commit adds.
const AXIS = Array.from({ length: 24 }, (_, i) => vn(`ven_axis_${String(i).padStart(2, '0')}`, 39.9200 + i * 0.001, -75.2000, 'BAR',
  `ChIJimportAxisPlace${String(i).padStart(3, '0')}`, weekFor(100 + i * 7)));
const NEW1 = vn('ven_off_new_1', 39.94123456789012, -75.15001, 'RESTAURANT', 'ChIJimportOfflineNew01', weekFor(31),
  { rating: 4.35, reviews: 88, name: 'Offline, "One"' });
const NEW2 = vn('ven_off_new_2', 39.96001, -75.13001, 'CAFE', 'ChIJimportOfflineNew02', weekFor(41), { rating: 4, reviews: 0 });
let phillyDir;
let phillyNotFound;

async function seedAxis() {
  for (const v of AXIS) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude, venue_category, timezone)
       VALUES ($1, $2, $3, 'philly', $4, $5, 'bar', 'America/New_York') RETURNING id`,
      [v.placeId, v.id, v.name, v.lat, v.lng]
    );
    const params = [];
    const values = [];
    for (let d = 0; d < 7; d++) {
      for (let s = 0; s < 24; s++) {
        const cell = bestTimeSlotToLocal(s, bestTimeDayToJsDay(d));
        params.push(row.id, cell.dayOfWeek, cell.hour, v.week[d][s]);
        const b = params.length - 4;
        values.push(`($${b + 1}, 'weekly', 'venue_local', $${b + 2}, $${b + 3}, 'bar', $${b + 4}, false, 'no_observation_date')`);
      }
    }
    await pool.query(
      `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
                                     busyness_pct, events_observed, events_unavailable_reason)
       VALUES ${values.join(', ')}`, params
    );
  }
}

async function harvestOffline(args) {
  const saved = { fetch: globalThis.fetch, log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('the network was reached'); };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = console.log;
  console.error = console.log;
  try {
    const summary = await H.harvest({ argv: ['node', 'harvestVenueFilter.js', ...args], pool, sleep: async () => {} });
    return { summary, out: lines.join('\n'), fetches };
  } finally {
    Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error });
    globalThis.fetch = saved.fetch;
  }
}

const countRows = async () => (await pool.query('SELECT (SELECT COUNT(*) FROM ml_venues)::int AS v, (SELECT COUNT(*) FROM ml_training_data)::int AS t')).rows[0];

test('--offline answers from the cache alone: no fetch, no key, misses counted and checked', async () => {
  await seedAxis();
  phillyDir = path.join(tmp('flock-import-philly-'), 'philly-2026-11');
  // The empty boxes 404 on Wednesday, as BestTime does for a box it holds
  // nothing in; those answers are never cached.
  const r = await fillCache(phillyDir, {
    cities: ['philly'], radiusKm: 20, venues: [...AXIS, NEW1, NEW2],
    notFoundWhen: ({ day, page, inBox }) => day === 2 && page === 0 && inBox.length === 0,
  });
  phillyNotFound = r.notFound;
  assert.ok(phillyNotFound > 0, 'the fixture has no 404 to miss');

  assert.match(H.parseArgs(['node', 'h', '--city=philly', '--offline']).error, /--cache-dir/);
  assert.match(H.parseArgs(['node', 'h', '--city=philly', '--offline', `--cache-dir=${phillyDir}`, '--commit']).error, /--expect-misses/);
  assert.match(H.parseArgs(['node', 'h', '--city=philly', '--expect-misses=1']).error, /--offline/);
  // An offline run makes nothing: a directory that is not there is refused.
  const missing = await harvestOffline(['--city=philly', '--offline', `--cache-dir=${path.join(phillyDir, 'nope')}`]);
  assert.equal(missing.summary.aborted, true);
  assert.match(missing.summary.abortReason, /--cache-dir could not be read \(ENOENT\)/);
  assert.equal(fs.existsSync(path.join(phillyDir, 'nope')), false);
  // No key in the environment is needed.
  const savedKey = process.env.BESTTIME_API_KEY;
  delete process.env.BESTTIME_API_KEY;
  try {
    const before = await countRows();
    const dry = await harvestOffline(['--city=philly', '--new-only', '--offline', `--cache-dir=${phillyDir}`]);
    assert.equal(dry.summary.aborted, false, dry.summary.abortReason);
    assert.equal(dry.fetches, 0);
    assert.doesNotMatch(dry.out, /Account (before|after)/);
    assert.equal(dry.summary.stats.requests, 0);
    assert.equal(dry.summary.stats.cacheMisses, phillyNotFound);
    assert.deepEqual([dry.summary.offline.filesRead, dry.summary.offline.filesUnread], [r.files, 0]);
    assert.equal(dry.summary.plan.new, 2);
    assert.equal(dry.summary.axisVerdict.pass, true, dry.summary.axisVerdict.reason);
    assert.equal(dry.summary.exitCode, 0);
    assert.deepEqual(await countRows(), before, 'a dry run wrote');

    // A miss that was not a 404 refuses the commit before anything is planned.
    const wrong = await harvestOffline(['--city=philly', '--new-only', '--offline', `--cache-dir=${phillyDir}`, '--commit',
      `--expect-misses=${phillyNotFound - 1}`]);
    assert.equal(wrong.summary.aborted, true);
    assert.match(wrong.summary.abortReason, /REFUSED: \d+ questions had no answer in --cache-dir/);
    assert.equal(wrong.fetches, 0);
    assert.deepEqual(await countRows(), before, 'a refused commit wrote');

    const commit = await harvestOffline(['--city=philly', '--new-only', '--offline', `--cache-dir=${phillyDir}`, '--commit',
      `--expect-misses=${phillyNotFound}`]);
    assert.equal(commit.summary.aborted, false, commit.summary.abortReason);
    assert.equal(commit.summary.exitCode, 0);
    assert.equal(commit.fetches, 0);
    assert.equal(commit.summary.venuesInserted, 2);
  } finally {
    process.env.BESTTIME_API_KEY = savedKey;
  }
  // Inside an offline run any fetch is refused before it leaves.
  await assert.rejects(H.withNoNetwork(() => fetch('https://besttime.app/api/v1/keys/x')), /REFUSED: an --offline run makes no request/);
});

test('--parity: every exported row of the harvested venues equals the generator\'s, and a changed field is caught', async () => {
  assert.ok(phillyDir, 'the --offline test runs first');
  // The harvest stamps the month at write time; these were written by this
  // test, today, and the parity fixture's answers say November. The real
  // harvest wrote November's rows in November.
  await pool.query(`UPDATE ml_training_data t SET month = 11, season = 'fall' FROM ml_venues v
                     WHERE v.id = t.venue_id AND v.besttime_status = $1`, [H.HARVEST_STATUS]);
  const outDir = tmp('flock-import-export-');
  const exported = await exporter.runExport({ pool: roPool, outDir, includeHarvested: true, log: () => {} });
  // The snapshot, as plan step C.4 takes it (plus besttime_status).
  const { rows } = await pool.query(
    'SELECT id, besttime_venue_id, google_place_id, name, latitude, longitude, city, besttime_status FROM ml_venues ORDER BY id'
  );
  const csv = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const snap = path.join(outDir, 'snapshot.csv');
  fs.writeFileSync(snap, ['id,besttime_venue_id,google_place_id,name,latitude,longitude,city,besttime_status',
    ...rows.map((r) => [r.id, r.besttime_venue_id, r.google_place_id, r.name, r.latitude, r.longitude, r.city, r.besttime_status].map(csv).join(','))]
    .join('\n') + '\n');
  const parity = (exportCsv, extra = []) => runImport(['--parity', `--cache-dir=${phillyDir}`, '--cities=philly', '--radius-km=20',
    `--identity-snapshot=${snap}`, `--export-csv=${exportCsv}`, ...extra]);

  const ok = await parity(exported.trainPath, [`--expect-misses=${phillyNotFound}`]);
  assert.equal(ok.result.exitCode, 0, ok.out);
  assert.equal(ok.result.venues, 2);
  const harvestedRows = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_training_data t JOIN ml_venues v ON v.id = t.venue_id WHERE v.besttime_status = $1`,
    [H.HARVEST_STATUS]
  )).rows[0].n;
  assert.equal(ok.result.rowsCompared, harvestedRows);
  assert.equal(ok.result.rowsEqual, harvestedRows);
  assert.match(ok.out, /24 others left out/);

  // One rating changed, and one row gone.
  const { rows: [one] } = await pool.query('SELECT id FROM ml_venues WHERE besttime_venue_id = $1', [NEW1.id]);
  const lines = fs.readFileSync(exported.trainPath, 'utf8').split('\n');
  const mine = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith(`${one.id},`)).map(([, i]) => i);
  assert.ok(mine.length > 2);
  const f = I.parseCsv(lines[mine[0]])[0];
  assert.equal(f[col('rating')], '4.4');
  f[col('rating')] = '4.3';
  lines[mine[0]] = f.join(',');
  lines.splice(mine[1], 1);
  const tampered = path.join(outDir, 'tampered.csv');
  fs.writeFileSync(tampered, lines.join('\n'));
  const bad = await parity(tampered);
  assert.equal(bad.result.exitCode, 1);
  assert.equal(bad.result.mismatches.rating, 1);
  assert.equal(Object.values(bad.result.mismatches).reduce((a, b) => a + b, 0), 1);
  assert.equal(bad.result.missing, 1);
  assert.match(bad.out, /PARITY FAIL/);
});
