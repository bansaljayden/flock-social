'use strict';
// ---------------------------------------------------------------------------
// scripts/ml/harvestVenueFilter.js against a REAL migrated Postgres and a fake
// BestTime.
//
// The harvester's claims are about rows and identities, so they are checked
// where rows and identities live: this file boots the repo's embedded-postgres
// dev dependency, applies the real migration chain with db/migrate.js (so
// migration 023's axis CHECK, 024's weekly key and 060's BestTime-id index are
// all present and judging), and replaces fetch with a fake Venue Filter that
// answers from a fixture by bounding box, day and page. Nothing here reaches
// BestTime: the key is fake and set before the require, and dotenv never
// overwrites a variable that is already set.
//
// What is pinned, and why:
//   * the slot -> (venue-local day, hour) mapping is collectWeekly's, for every
//     slot of every day, in the pure function AND in the rows that land;
//   * no request other than GET /venues/filter and GET /keys/<key> is ever
//     made, and the in-process guard refuses the admitting endpoints before a
//     byte leaves;
//   * identity: an existing row by BestTime id, an existing row by Google place
//     id (curves filed, no id stamped), an existing row within 40 m under a
//     similar name (the same), a new row only with a real place id inside
//     --radius-km, outside-market venues skipped, and never a second identity
//     for one place;
//   * the axis proof: 24 known venues whose stored weeks match at rotation 0
//     let --commit through; 24 whose stored weeks put slot 0 at midnight are
//     found at +6 and refused, as is a run with too few venues to compare;
//   * a refreshed row keeps its stored besttime_epoch;
//   * a dry run writes nothing (xmin snapshot), a commit upserts, a rerun
//     changes nothing but collected_at;
//   * an empty run, an aborted run and a refused key all exit nonzero;
//   * paging stops at the cap and a capped box is split, down to a minimum;
//   * every training city (2026-11-17): any CITIES key is asked about around
//     its own centroid, the holdout cities and beijing are refused, --city=all
//     is the rest, and a PA run's boxes are the ones it always asked;
//   * --new-only writes nothing for a venue already held, by either id or as
//     a near-duplicate, and a new venue's row carries its own city and zone;
//   * the result budget stops a run before it could pass, and no venue is
//     written with part of its week;
//   * a request that may have been billed without an answer holds a page
//     against the budget and no retry is sent past it (2026-11-18), and a
//     record naming another day refuses the run, budget stop or not.
//
// HOW TO RUN
//   cd backend && node --test __tests__/harvestVenueFilter.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
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
const PG_PORT = pickEmbeddedPgPort('harvestVenueFilter');
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_harvest_test`;
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';
const FAKE_PRIVATE = 'pri_0123456789abcdef0123456789abcdef';
const FAKE_PUBLIC = 'pub_fedcba9876543210fedcba9876543210';
process.env.BESTTIME_API_KEY = FAKE_PRIVATE;
process.env.BESTTIME_API_KEY_PUBLIC = FAKE_PUBLIC;

const { migrate } = require('../db/migrate');
const harvester = require('../scripts/ml/harvestVenueFilter');
const { bestTimeSlotToLocal } = require('../scripts/ml/collectWeekly');
const { bestTimeDayToJsDay } = require('../scripts/ml/config');
const { nearestPaCity } = require('../scripts/ml/addDemandVenues');
const { CITIES } = require('../scripts/ml/config');
const { HOLDOUT_CITIES } = require('../scripts/ml/train/export_training_data');

let pg;
let pool;
let dataDir;

// ---------------------------------------------------------------------------
// The fixture: one week per venue, BestTime day d slot s reading
// (seed + 24d + s) % 101, so neighbouring cells differ and a shifted row
// cannot pass by coincidence.
// ---------------------------------------------------------------------------
const weekFor = (seed) => Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, s) => (seed + 24 * d + s) % 101));
const ZERO_WEEK = Array.from({ length: 7 }, () => Array(24).fill(0));

function fx(venueId, lat, lng, type, placeId, seed, extra = {}) {
  return { venueId, lat, lng, type, placeId, week: seed === null ? ZERO_WEEK : weekFor(seed), rating: 4.4, reviews: 120, ...extra };
}

// A tile corner the harvester will ask about (both markets, `radiusKm`) that
// satisfies `ok`, derived from the tiling itself so the fixture cannot drift
// out of the area the harvester covers.
function tileCorner(radiusKm, ok, what) {
  for (const t of harvester.buildTiles(['philly', 'lehigh'], 20, radiusKm)) {
    for (const [lat, lng] of [[t.s + 0.5, t.w + 0.5], [t.s + 0.5, t.e - 0.5], [t.n - 0.5, t.w + 0.5], [t.n - 0.5, t.e - 0.5]]) {
      if (ok(nearestPaCity(lat / 1000, lng / 1000))) return { lat: lat / 1000, lng: lng / 1000 };
    }
  }
  throw new Error(`fixture: no tile corner ${what}`);
}
// More than MAX_KM from both centroids, asked about only at --radius-km=80.
const OUT = tileCorner(80, (w) => !w.cityKey, 'lies outside both markets');
// Philadelphia's market, past the default 20 km, still inside a default tile.
const FAR = tileCorner(20, (w) => w.cityKey === 'philly' && w.km > 21, 'lies past 20 km in a default tile');

// Twenty-four venues the corpus already holds by BestTime id, with the weekly
// rows collectWeekly would have stored for them: the evidence the axis proof
// compares against. Four of them come back from the filter under a place id
// other than the one stored.
const AXIS = Array.from({ length: 24 }, (_, i) => fx(
  `ven_axis_${String(i).padStart(2, '0')}`, 39.9200 + i * 0.001, -75.2000, 'BAR',
  i < 20 ? `ChIJharvestAxisPl${String(i).padStart(3, '0')}` : `ChIJharvestAxisNw${String(i).padStart(3, '0')}`,
  100 + i * 7
));
// Twenty-four more whose stored rows put slot 0 at MIDNIGHT: what the corpus
// would hold if the filter's origin differed from the transform's by six
// hours. Only the gate test asks the fake for them.
const SHIFTED = Array.from({ length: 24 }, (_, i) => fx(
  `ven_shift_${String(i).padStart(2, '0')}`, 40.0000 + i * 0.001, -75.2500, 'BAR',
  `ChIJharvestShiftP${String(i).padStart(3, '0')}`, 300 + i * 5
));

const V = {
  // The twin first, so the order-independence of the identity pass is tested:
  // its place id belongs to ven_pseudo_row, which is only known by BestTime id.
  twinOther: fx('ven_twin_other', 39.93011, -75.19011, 'BAR', 'ChIJharvestTwinPlc01', 5),
  pseudoRow: fx('ven_pseudo_row', 39.93012, -75.19012, 'BAR', 'ChIJharvestTwinPlc01', 7),
  knownBt: fx('ven_known_bt', 39.95301, -75.16301, 'BAR', 'ChIJharvestKnownBt01', 10),
  knownPlace: fx('ven_known_place', 39.96001, -75.17001, 'RESTAURANT', 'ChIJharvestKnownPl01', 20),
  newPhilly: fx('ven_new_philly', 39.94001, -75.15001, 'CAFE', 'ChIJharvestNewPhl001', 30),
  newLehigh: fx('ven_new_lehigh', 40.61001, -75.48001, 'CLUBS', 'ChIJharvestNewLeh001', 40, { rating: 0, reviews: 0 }),
  noPlace: fx('ven_no_place', 39.94501, -75.16001, 'RESTAURANT', null, 50),
  pseudoPlace: fx('ven_pseudo', 39.94601, -75.16101, 'RESTAURANT', 'bt_ven_pseudo', 60),
  outside: fx('ven_outside', OUT.lat, OUT.lng, 'BAR', 'ChIJharvestOutside01', 70),
  dupA: fx('ven_dup_a', 39.97001, -75.14001, 'BAR', 'ChIJharvestDupPlace1', 80),
  dupB: fx('ven_dup_b', 39.97011, -75.14011, 'BAR', 'ChIJharvestDupPlace1', 90),
  otherBt: fx('ven_other_bt', 39.98001, -75.13001, 'BAR', 'ChIJharvestHeldElse1', 15),
  unmapped: fx('ven_supermarket', 39.98501, -75.12501, 'SUPERMARKET', 'ChIJharvestSuperMk01', 25),
  zero: fx('ven_zero', 39.99001, -75.12001, 'BAR', 'ChIJharvestZeroWk001', null),
  // Identity rule 4. The seeded "The Olde Bar" row sits 17 m away under
  // another place id; "Sushi Palace" is as close and a different venue.
  nearDup: fx('ven_near_dup', 39.94135, -75.14510, 'BAR', 'ChIJharvestNearNew01', 35, { name: 'Olde Bar Philadelphia' }),
  nearOther: fx('ven_near_other', 39.94130, -75.14505, 'RESTAURANT', 'ChIJharvestNearOth01', 45, { name: 'Sushi Palace' }),
  // The seeded row it resembles holds another BestTime id.
  nearHeld: fx('ven_near_held', 39.93129, -75.16129, 'RESTAURANT', 'ChIJharvestNearHeld2', 55, { name: 'Bing Bing Dim Sum' }),
  // Two new listings of one beer hall, 15 m apart.
  twinHallA: fx('ven_twin_hall_a', 39.96870, -75.13450, 'BAR', 'ChIJharvestTwinHallA', 65, { name: 'Frankford Hall' }),
  twinHallB: fx('ven_twin_hall_b', 39.96883, -75.13455, 'BAR', 'ChIJharvestTwinHallB', 75, { name: 'Frankford Hall Beer Garden' }),
  // Past the default radius: a new one is skipped, a known one refreshed.
  farNew: fx('ven_far_new', FAR.lat, FAR.lng, 'BAR', 'ChIJharvestFarNew001', 85),
  farKnown: fx('ven_far_known', FAR.lat + 0.0002, FAR.lng, 'BAR', 'ChIJharvestFarKnwn01', 95),
};
const FIXTURE = [...Object.values(V), ...AXIS];

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function toRecord(v, day, { sayDay = true } = {}) {
  const rec = {
    venue_id: v.venueId, venue_name: v.name || `Venue ${v.venueId}`, venue_address: '1 Test St, Philadelphia, PA',
    venue_lat: v.lat, venue_lng: v.lng, venue_type: v.type, day_int: day, day_info: { day_int: day },
    day_raw_whole: v.week[day], rating: v.rating, reviews: v.reviews, price_level: 2,
  };
  if (!sayDay) { delete rec.day_int; delete rec.day_info; }
  // The published schema names no place-id field; the harvester reads the
  // likely spellings, and this fake uses one of them.
  if (v.placeId) rec.place_id = v.placeId;
  return rec;
}

// A fake BestTime. The filter answers by inclusive bounding box, day and
// page; `reportTotal` makes venues_n the box total rather than the page count
// (the documentation does not say which it is, and the harvester must be right
// under both). `noDayInt(v, day)` true leaves day_int out of that venue's
// record for that day, and `dayFor(v, day)` is the day_int that venue's record
// names when `day` is asked. `echoKey` puts the private key in every filter
// answer, as an API that echoes its request might. Every request is recorded.
function fakeBestTime(fixture, {
  reportTotal = false, failDay = null, failStatus = 402, ignoreDay = false, noDayInt = () => false, echoKey = false,
  dayFor = (v, day) => day,
} = {}) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || 'GET').toUpperCase();
    requests.push({ method, path: url.pathname, params: Object.fromEntries(url.searchParams), url: url.toString() });
    if (url.pathname.startsWith('/api/v1/keys/')) {
      return jsonResponse(200, {
        api_key_private: FAKE_PRIVATE, api_key_public: FAKE_PUBLIC,
        status: 'OK', active: true, valid: true, credits_forecast: 1, credits_query: 1,
      });
    }
    if (url.pathname === '/api/v1/venues/filter' && method === 'GET') {
      const p = url.searchParams;
      const day = Number(p.get('day_int'));
      if (failDay !== null && day === failDay) return jsonResponse(failStatus, {});
      const [s, n, w, e] = ['lat_min', 'lat_max', 'lng_min', 'lng_max'].map((k) => Number(p.get(k)));
      const limit = Number(p.get('limit'));
      const page = Number(p.get('page'));
      const inBox = fixture.filter((v) => v.lat >= s && v.lat <= n && v.lng >= w && v.lng <= e);
      const slice = inBox.slice(page * limit, page * limit + limit);
      return jsonResponse(200, {
        status: 'OK',
        venues: slice.map((v) => toRecord(v, ignoreDay ? 0 : dayFor(v, day), { sayDay: !noDayInt(v, day) })),
        venues_n: reportTotal ? inBox.length : slice.length,
        ...(echoKey ? { api_key_private: p.get('api_key_private'), echo: `key=${p.get('api_key_private')}` } : {}),
      });
    }
    return jsonResponse(404, {});
  };
  return { requests, fetchImpl };
}

const ALL_REQUESTS = [];

async function runHarvest(args, fake) {
  const saved = { fetch: globalThis.fetch, log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  globalThis.fetch = fake.fetchImpl;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = console.log;
  console.error = console.log;
  try {
    const summary = await harvester.harvest({
      argv: ['node', 'harvestVenueFilter.js', ...args], pool, sleep: async () => {},
    });
    return { summary, out: lines.join('\n') };
  } finally {
    Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error });
    globalThis.fetch = saved.fetch;
    ALL_REQUESTS.push(...fake.requests);
  }
}

function assertNoKey(out) {
  assert.ok(!out.includes(FAKE_PRIVATE), 'the private key was printed');
  assert.ok(!out.includes(FAKE_PUBLIC), 'the public key was printed');
}

async function snapshot() {
  const { rows: venues } = await pool.query(
    `SELECT id, google_place_id, besttime_venue_id, city, is_active, besttime_status, last_collected_at,
            xmin::text AS xm
       FROM ml_venues ORDER BY id`
  );
  const { rows: training } = await pool.query(
    `SELECT id, venue_id, day_of_week, hour, busyness_pct, collected_at, xmin::text AS xm
       FROM ml_training_data ORDER BY id`
  );
  return { venues, training };
}

const seeded = {};

async function insertVenue(tag, placeId, btId, category, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                            venue_category, rating, review_count, timezone)
     VALUES ($1, $2, $3, $9, $7, $8, $4, $5, $6, $10) RETURNING id`,
    [placeId, btId, extra.name || `Seeded ${tag}`, category,
      'rating' in extra ? extra.rating : 4.2, 'reviews' in extra ? extra.reviews : 300,
      extra.lat ?? 39.95, extra.lng ?? -75.16, extra.city || 'philly', extra.tz || 'America/New_York']
  );
  seeded[tag] = rows[0].id;
}

// The week collectWeekly would have stored for fixture venue `v`: each
// BestTime slot through the transform, or, with `midnight`, as if slot 0
// were midnight (the origin the axis proof must catch).
async function storeWeek(venueRowId, v, { midnight = false } = {}) {
  const values = [];
  const params = [];
  for (let d = 0; d < 7; d++) {
    for (let s = 0; s < 24; s++) {
      const js = bestTimeDayToJsDay(d);
      const cell = midnight ? { dayOfWeek: js, hour: s } : bestTimeSlotToLocal(s, js);
      params.push(venueRowId, cell.dayOfWeek, cell.hour, v.week[d][s]);
      const b = params.length - 4;
      values.push(`($${b + 1}, 'weekly', 'venue_local', $${b + 2}, $${b + 3}, 'bar', $${b + 4}, 1786000000, false, 'no_observation_date')`);
    }
  }
  await pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
                                   busyness_pct, besttime_epoch, events_observed, events_unavailable_reason)
     VALUES ${values.join(', ')}`,
    params
  );
}

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-harvest-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'harvestVenueFilter', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  // UTF8, as Railway's Postgres is. embedded-postgres runs initdb under the
  // machine's locale, WIN1252 on this Windows box, where a Hangul, Thai or
  // Arabic venue name cannot be stored at all (dumpLiteralRestore.test.js has
  // the same note). template0 because template1 cannot be copied into another
  // encoding.
  const boot = new Pool({ connectionString: CONN.replace(/\/flock_harvest_test$/, '/postgres'), max: 1 });
  try {
    await boot.query("CREATE DATABASE flock_harvest_test ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
  } finally {
    await boot.end();
  }
  pool = new Pool({ connectionString: CONN });
  await migrate(pool);

  await insertVenue('knownBt', 'ChIJharvestKnownBt01', 'ven_known_bt', 'bar');
  await insertVenue('knownPlace', 'ChIJharvestKnownPl01', null, 'restaurant');
  await insertVenue('otherBt', 'ChIJharvestHeldElse1', 'ven_someone_else', 'bar');
  // A row the old discovery path minted: pseudo place id, real BestTime id.
  await insertVenue('pseudoRow', 'bt_ven_pseudo_row', 'ven_pseudo_row', 'bar', { rating: null, reviews: null });
  // Identity rule 4's rows, and the known venue past the default radius.
  await insertVenue('nearRow', 'ChIJharvestNearRow01', null, 'bar', { name: 'The Olde Bar', lat: 39.94120, lng: -75.14500 });
  await insertVenue('nearHeldRow', 'ChIJharvestNearHeld1', 'ven_someone_else_2', 'restaurant',
    { name: 'Bing Bing Dim Sum', lat: 39.93120, lng: -75.16120 });
  await insertVenue('farKnown', 'ChIJharvestFarKnwn01', 'ven_far_known', 'bar', { lat: FAR.lat + 0.0002, lng: FAR.lng });
  for (const [i, v] of AXIS.entries()) {
    await insertVenue(`axis${i}`, `ChIJharvestAxisPl${String(i).padStart(3, '0')}`, v.venueId, 'bar', { lat: v.lat, lng: v.lng });
    await storeWeek(seeded[`axis${i}`], v);
  }
  for (const [i, v] of SHIFTED.entries()) {
    await insertVenue(`shift${i}`, v.placeId, v.venueId, 'bar', { lat: v.lat, lng: v.lng });
    await storeWeek(seeded[`shift${i}`], v, { midnight: true });
  }

  // A stale weekly row the harvest must refresh in place: Tuesday 20:00 is
  // BestTime Tuesday (day 1) slot 14, which the fixture fills with 48.
  const { rows } = await pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
                                   busyness_pct, besttime_epoch, events_observed, events_unavailable_reason)
     VALUES ($1, 'weekly', 'venue_local', 2, 20, 'bar', 99, 1786000000, false, 'no_observation_date') RETURNING id`,
    [seeded.knownBt]
  );
  seeded.staleRowId = rows[0].id;
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'harvestVenueFilter');
});

// ---------------------------------------------------------------------------
// The slot transform.
// ---------------------------------------------------------------------------
test('weekCells maps every slot of every day exactly as collectWeekly does', () => {
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => [d, Array.from({ length: 24 }, (_, s) => (d * 24 + s) % 101)]);
  const cells = harvester.weekCells(days);
  assert.strictEqual(cells.length, 168, 'a full week is 168 cells');
  assert.strictEqual(new Set(cells.map((c) => `${c.dayOfWeek}:${c.hour}`)).size, 168, 'no cell twice');
  let i = 0;
  for (let d = 0; d < 7; d++) {
    for (let s = 0; s < 24; s++, i++) {
      const want = bestTimeSlotToLocal(s, bestTimeDayToJsDay(d));
      assert.deepStrictEqual(
        { dayOfWeek: cells[i].dayOfWeek, hour: cells[i].hour, busyness: cells[i].busyness },
        { dayOfWeek: want.dayOfWeek, hour: want.hour, busyness: (d * 24 + s) % 101 },
        `BestTime day ${d} slot ${s}`
      );
    }
  }
  // Hard literals, so a broken import cannot agree with itself. BestTime's
  // Monday is 0; its day starts at 06:00; slots 18-23 belong to the next day.
  const at = (d, s) => cells[d * 24 + s];
  assert.deepStrictEqual([at(0, 0).dayOfWeek, at(0, 0).hour], [1, 6], 'Monday slot 0 is Monday 6 AM');
  assert.deepStrictEqual([at(0, 18).dayOfWeek, at(0, 18).hour], [2, 0], 'Monday slot 18 is Tuesday midnight');
  assert.deepStrictEqual([at(6, 18).dayOfWeek, at(6, 18).hour], [1, 0], 'Sunday slot 18 is Monday midnight');
  assert.deepStrictEqual([at(5, 20).dayOfWeek, at(5, 20).hour], [0, 2], 'Saturday slot 20 is Sunday 2 AM');
});

test('the harvester imports the transform and the axis rather than keeping copies', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'harvestVenueFilter.js'), 'utf8');
  assert.match(src, /bestTimeSlotToLocal[\s\S]{0,160}?\} = require\('\.\/collectWeekly'\);/);
  assert.ok(!/function bestTimeSlotToLocal/.test(src), 'a second copy of the transform');
  assert.ok(!/\(slot \+ 6\)|slot \+ BESTTIME_DAY_START_HOUR/.test(src), 'the shift is spelled out locally');
  assert.match(src, /HOUR_AXIS_VENUE_LOCAL/);
});

// ---------------------------------------------------------------------------
// The request guard.
// ---------------------------------------------------------------------------
test('the guard admits the venue filter and the key endpoint, and refuses every admitting call', () => {
  const ok = [
    ['https://besttime.app/api/v1/venues/filter?api_key_private=x&lat_min=1&day_int=0', 'GET'],
    [`https://besttime.app/api/v1/keys/${FAKE_PRIVATE}`, 'GET'],
  ];
  for (const [url, method] of ok) assert.doesNotThrow(() => harvester.assertAllowedRequest(url, method), url);
  const refused = [
    ['https://besttime.app/api/v1/forecasts?venue_name=Bar&venue_address=1%20St', 'POST'], // by name: admits
    ['https://besttime.app/api/v1/forecasts?venue_id=ven_x', 'POST'],
    ['https://besttime.app/api/v1/forecasts/live?venue_id=ven_x', 'POST'],
    ['https://besttime.app/api/v1/venues/search?q=bars', 'POST'],
    ['https://besttime.app/api/v1/venues/progress?job_id=1', 'GET'],
    ['https://besttime.app/api/v1/forecasts/week?venue_id=ven_x', 'GET'],
    ['https://besttime.app/api/v1/venues/filter?lat_min=1&live=True', 'GET'],
    ['https://besttime.app/api/v1/venues/filter?lat_min=1&live_refresh=True', 'GET'],
    ['https://besttime.app/api/v1/venues/filter?lat_min=1', 'POST'],
    ['https://besttime.app/api/v1/keys/', 'GET'],
    ['https://example.com/api/v1/venues/filter', 'GET'],
  ];
  for (const [url, method] of refused) {
    assert.throws(() => harvester.assertAllowedRequest(url, method), /REFUSED/, `${method} ${url}`);
  }
});

test('inside a run, an admitting call is refused before it reaches the network', async () => {
  const reached = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => { reached.push(String(u)); return jsonResponse(200, {}); };
  try {
    await assert.rejects(
      harvester.withAdmissionGuard(() => fetch('https://besttime.app/api/v1/forecasts?venue_name=x&venue_address=y', { method: 'POST' })),
      /REFUSED/
    );
    await assert.rejects(
      harvester.withAdmissionGuard(() => fetch(new URL('https://besttime.app/api/v1/venues/search?q=bars'), { method: 'POST' })),
      /REFUSED/
    );
    assert.deepStrictEqual(reached, [], 'a refused call reached fetch');
    // And the guard is lifted afterwards.
    await fetch('https://example.com/');
    assert.strictEqual(reached.length, 1);
  } finally {
    globalThis.fetch = saved;
  }
});

test('the harvester source never names an admitting endpoint in code', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'harvestVenueFilter.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/api\/v1\/forecasts/.test(code), 'a forecast URL in the harvester');
  assert.ok(!/venues\/search/.test(code), 'a venue search URL in the harvester');
  assert.ok(!/fetchWeeklyForecast|fetchLiveBusyness/.test(code), 'an admitting fetcher imported');
});

// ---------------------------------------------------------------------------
// Identity and writes.
// ---------------------------------------------------------------------------
test('a dry run reports the plan and writes nothing', async () => {
  const before = await snapshot();
  const { summary, out } = await runHarvest([], fakeBestTime(FIXTURE));
  assertNoKey(out);
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.strictEqual(summary.commit, false);
  assert.strictEqual(summary.exitCode, 0);
  // 3 known + 24 axis by BestTime id; one by place id; one near-duplicate;
  // philly, lehigh, one of the dup pair, Sushi Palace and one beer hall new.
  assert.deepStrictEqual(summary.plan, { known_bt: 27, known_place: 1, known_near: 1, new: 5 });
  assert.strictEqual(summary.rowsPlanned, 34 * 168);
  assert.deepStrictEqual(summary.skipped, {
    // The outside venue is not asked about at all inside 20 km.
    outsideMarkets: 0, otherMarket: 0, outsideRadius: 1, noPlaceId: 1, unusablePlaceId: 1, placeHeldByOtherBtId: 1,
    placeClaimedTwice: 2, nearDupHeldByOtherBtId: 1, nearDupClaimed: 0, nearDuplicateInRun: 1,
    unmappedType: 1, noName: 0, noSignal: 1, noCoordinates: 0,
  });
  assert.deepStrictEqual(summary.placeIds, {
    knownBt: 27, same: 22, differs: 4, storedPseudo: 1, filterUnusable: 0, filterNone: 0,
  });
  assert.deepStrictEqual(summary.nearDuplicates, { filed: 1, heldByOtherBtId: 1, claimed: 0, inRun: 1 });
  assert.strictEqual(summary.axisVerdict.pass, true, summary.axisVerdict.reason);
  assert.strictEqual(summary.axis.bestShift, 0);
  assert.strictEqual(summary.axis.venues, 24, 'the 24 axis venues; knownBt has one stored cell and is too thin');
  assert.match(out, /DRY RUN/);
  assert.match(out, /within 20 km/);
  assert.match(out, /Would write 5712 weekly rows for 34 venues and add 5 ml_venues rows/);
  assert.match(out, /AXIS PROOF: 27 venues known by BestTime id, 25 with stored weekly rows; 24 compared/);
  assert.match(out, /\n +0 +4032 +0\.00 +100\.0% +100\.0% +1\.000 +24 +<- best/, 'the rotation-0 row of the table');
  assert.match(out, /\n +\+6 +4032 /, 'the six-hour rotation is always printed');
  assert.match(out, /COMMIT GATE: PASS/);
  assert.match(out, /PLACE IDS, venues known by BestTime id: 22 of 27 carry the stored google_place_id; 4 carry a different real one; 1 are stored under a bt_/);
  assert.match(out, /NEAR-DUPLICATES: 2 venues .* within 40 m .*: 1 filed under that row \(no new row\), 1 skipped \(the row holds another BestTime id\)/);
  assert.match(out, /Place ids refused as no Google shape, by first four characters: bt_v\.\. 1\./);
  assert.match(out, /PEAK HOUR by category, venue-local/);
  assert.match(out, /Account before: key OK/);
  assert.match(out, /Account after: key OK/);
  assert.match(out, /tiles of about 20 km/);
  assert.deepStrictEqual(await snapshot(), before, 'the dry run changed or rewrote a row');
});

test('at --radius-km=80 the market rule decides: the far venue is new, the outside one is skipped', async () => {
  const { summary, out } = await runHarvest(['--radius-km=80'], fakeBestTime(FIXTURE));
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.match(out, /within 80 km/);
  assert.strictEqual(summary.skipped.outsideMarkets, 1);
  assert.strictEqual(summary.skipped.outsideRadius, 0);
  assert.strictEqual(summary.plan.new, 6);
  assert.ok(summary.tiles > 40, `${summary.tiles} tiles cannot cover two 80 km circles`);
});

test('--commit files every week under the right identity and mints none twice', async () => {
  const { summary, out } = await runHarvest(['--commit'], fakeBestTime(FIXTURE));
  assertNoKey(out);
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.strictEqual(summary.exitCode, 0);
  assert.strictEqual(summary.venuesInserted, 5);
  assert.strictEqual(summary.rowsWritten, 5712);
  assert.strictEqual(summary.rowsRefreshed, 1 + 24 * 168, 'the stale row and the axis weeks are refreshed, the rest are new');
  assert.strictEqual(summary.writeFailures, 0);
  assert.match(out, /COMMIT GATE: PASS/);

  // No second identity anywhere.
  const { rows: dupBt } = await pool.query(
    'SELECT besttime_venue_id FROM ml_venues WHERE besttime_venue_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1'
  );
  assert.deepStrictEqual(dupBt, []);
  const { rows: byBt } = await pool.query('SELECT * FROM ml_venues WHERE besttime_venue_id IS NOT NULL');
  const held = new Map(byBt.map((r) => [r.besttime_venue_id, r]));

  // Known by BestTime id: the same rows, nothing added.
  assert.strictEqual(held.get('ven_known_bt').id, seeded.knownBt);
  assert.strictEqual(held.get('ven_pseudo_row').id, seeded.pseudoRow);
  // Known by place id: the curves are filed under it and no id is stamped.
  const { rows: [kp] } = await pool.query('SELECT * FROM ml_venues WHERE id = $1', [seeded.knownPlace]);
  assert.strictEqual(kp.besttime_venue_id, null, 'a BestTime id was stamped onto an active row');
  assert.ok(!held.has('ven_known_place'));

  // New rows: a real place id, the right market, inactive, labelled.
  const np = held.get('ven_new_philly');
  assert.strictEqual(np.google_place_id, 'ChIJharvestNewPhl001');
  assert.strictEqual(np.city, 'philly');
  assert.strictEqual(np.venue_category, 'cafe');
  assert.strictEqual(np.is_active, false, 'a harvested venue joined the hourly live sweep');
  assert.strictEqual(np.besttime_status, harvester.HARVEST_STATUS);
  assert.strictEqual(np.timezone, 'America/New_York');
  assert.strictEqual(Number(np.rating), 4.4);
  assert.strictEqual(np.review_count, 120);
  assert.strictEqual(np.google_types, null, 'BestTime types were stored as Google types');
  assert.strictEqual(np.price_level, null);
  const nl = held.get('ven_new_lehigh');
  assert.strictEqual(nl.city, 'lehigh');
  assert.strictEqual(nl.venue_category, 'nightclub');
  assert.strictEqual(nl.rating, null, "BestTime's 0 means not available");
  assert.strictEqual(nl.review_count, null, "BestTime's 0 means not available");
  // One place, two BestTime venues: exactly one identity.
  assert.ok(held.has('ven_dup_a') !== held.has('ven_dup_b'), 'both or neither of the two venues for one place were added');

  // A near-duplicate: filed under the existing row, which keeps its own place
  // id and gets no BestTime id; no second row for the building.
  const { rows: [nr] } = await pool.query('SELECT * FROM ml_venues WHERE id = $1', [seeded.nearRow]);
  assert.strictEqual(nr.besttime_venue_id, null, 'a BestTime id was stamped onto a near-duplicate row');
  assert.strictEqual(nr.google_place_id, 'ChIJharvestNearRow01');
  const { rows: nearNew } = await pool.query("SELECT 1 FROM ml_venues WHERE google_place_id = 'ChIJharvestNearNew01'");
  assert.deepStrictEqual(nearNew, [], 'a second identity for The Olde Bar');
  // Close by but a different venue: new.
  assert.ok(held.has('ven_near_other'));
  // Of two listings of one beer hall, the lower BestTime id.
  assert.ok(held.has('ven_twin_hall_a'));

  // Never added.
  for (const id of ['ven_no_place', 'ven_pseudo', 'ven_outside', 'ven_other_bt', 'ven_supermarket', 'ven_zero', 'ven_twin_other',
    'ven_near_dup', 'ven_near_held', 'ven_twin_hall_b', 'ven_far_new']) {
    assert.ok(!held.has(id), `${id} was added`);
  }
  const { rows: heldElse } = await pool.query('SELECT COUNT(*)::int AS n FROM ml_training_data WHERE venue_id = $1', [seeded.nearHeldRow]);
  assert.strictEqual(heldElse[0].n, 0, "a near-duplicate's week was filed under a row holding another BestTime id");
  // Past the default radius, the known venue is still refreshed.
  assert.strictEqual(held.get('ven_far_known').id, seeded.farKnown);
  const { rows: pseudo } = await pool.query("SELECT google_place_id FROM ml_venues WHERE google_place_id LIKE 'bt\\_%'");
  assert.deepStrictEqual(pseudo.map((r) => r.google_place_id), ['bt_ven_pseudo_row'], 'a pseudo place id was minted');
  const { rows: twin } = await pool.query("SELECT COUNT(*)::int AS n FROM ml_venues WHERE google_place_id = 'ChIJharvestTwinPlc01'");
  assert.strictEqual(twin[0].n, 0, 'a second row for the building the pseudo row already holds');
  const { rows: other } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM ml_training_data WHERE venue_id = $1", [seeded.otherBt]
  );
  assert.strictEqual(other[0].n, 0, "one BestTime venue's week was filed under a row holding another");

  // The rows: collectWeekly's mapping, collectWeekly's labels.
  const written = [
    [seeded.knownBt, V.knownBt], [seeded.pseudoRow, V.pseudoRow], [seeded.knownPlace, V.knownPlace],
    [np.id, V.newPhilly], [nl.id, V.newLehigh],
    [(held.get('ven_dup_a') || held.get('ven_dup_b')).id, held.has('ven_dup_a') ? V.dupA : V.dupB],
    [seeded.nearRow, V.nearDup], [seeded.farKnown, V.farKnown],
    [held.get('ven_near_other').id, V.nearOther], [held.get('ven_twin_hall_a').id, V.twinHallA],
    [seeded.axis0, AXIS[0]], [seeded.axis23, AXIS[23]],
  ];
  const keptEpoch = new Set([seeded.axis0, seeded.axis23]);
  for (const [venueId, fixture] of written) {
    const expected = new Map();
    for (let d = 0; d < 7; d++) {
      for (let s = 0; s < 24; s++) {
        const local = bestTimeSlotToLocal(s, bestTimeDayToJsDay(d));
        expected.set(`${local.dayOfWeek}:${local.hour}`, fixture.week[d][s]);
      }
    }
    const { rows } = await pool.query(
      `SELECT id, day_of_week, hour, busyness_pct, collection_mode, hour_axis, label_source, besttime_epoch,
              events_observed, events_unavailable_reason, event_nearby, has_nearby_event, total_nearby_events,
              total_nearby_attendance, nearest_event_attendance, nearest_event_distance_km, nearest_event_type,
              temperature, is_raining, month, season
         FROM ml_training_data WHERE venue_id = $1`,
      [venueId]
    );
    assert.strictEqual(rows.length, 168, `${fixture.venueId}: not a full week`);
    for (const r of rows) {
      assert.strictEqual(r.busyness_pct, expected.get(`${r.day_of_week}:${r.hour}`),
        `${fixture.venueId} day ${r.day_of_week} hour ${r.hour}: wrong slot`);
      assert.strictEqual(r.collection_mode, 'weekly');
      assert.strictEqual(r.hour_axis, 'venue_local');
      assert.strictEqual(r.label_source, null, 'a weekly forecast row claimed a realtime label');
      if (keptEpoch.has(venueId) || r.id === seeded.staleRowId) {
        // A refreshed row keeps the epoch it had rather than being blanked.
        assert.strictEqual(Number(r.besttime_epoch), 1786000000, 'a stored analysis epoch was overwritten');
      } else {
        assert.strictEqual(r.besttime_epoch, null, 'an analysis epoch the filter never reported');
      }
      assert.strictEqual(r.events_observed, false);
      assert.strictEqual(r.events_unavailable_reason, 'no_observation_date');
      for (const c of ['event_nearby', 'has_nearby_event', 'total_nearby_events', 'total_nearby_attendance',
        'nearest_event_attendance', 'nearest_event_distance_km', 'nearest_event_type', 'temperature', 'is_raining']) {
        assert.strictEqual(r[c], null, `${c} is not NULL on a typical-week row`);
      }
      assert.ok(r.month >= 1 && r.month <= 12 && r.season, 'month and season must be the snapshot calendar');
    }
  }
  // The stale row was refreshed in place, not stacked beside.
  const { rows: [stale] } = await pool.query('SELECT busyness_pct, besttime_epoch FROM ml_training_data WHERE id = $1', [seeded.staleRowId]);
  assert.strictEqual(stale.busyness_pct, 48);
  assert.strictEqual(Number(stale.besttime_epoch), 1786000000, 'the known row lost its analysis epoch to NULL');
  const { rows: [stamped] } = await pool.query('SELECT last_collected_at FROM ml_venues WHERE id = $1', [seeded.knownBt]);
  assert.ok(stamped.last_collected_at, 'last_collected_at not set after rows landed');
});

test('a rerun changes nothing but the refresh time', async () => {
  const before = await snapshot();
  const { summary } = await runHarvest(['--commit'], fakeBestTime(FIXTURE));
  assert.strictEqual(summary.exitCode, 0);
  assert.strictEqual(summary.venuesInserted, 0);
  assert.strictEqual(summary.rowsInserted, 0);
  assert.strictEqual(summary.rowsRefreshed, 5712);
  const after = await snapshot();

  const venueKey = (v) => [v.id, v.google_place_id, v.besttime_venue_id, v.city, v.is_active, v.besttime_status].join('|');
  assert.deepStrictEqual(after.venues.map(venueKey), before.venues.map(venueKey), 'ml_venues changed on a rerun');
  const rowKey = (r) => [r.id, r.venue_id, r.day_of_week, r.hour, r.busyness_pct].join('|');
  assert.deepStrictEqual(after.training.map(rowKey), before.training.map(rowKey), 'weekly rows changed on a rerun');
  const beforeAt = new Map(before.training.map((r) => [r.id, r.collected_at.getTime()]));
  const refreshed = after.training.filter((r) => r.collected_at.getTime() > beforeAt.get(r.id));
  // Every row the rerun re-read, and only those: the SHIFTED venues were not asked about.
  const shifted = new Set(SHIFTED.map((_, i) => seeded[`shift${i}`]));
  assert.strictEqual(refreshed.length, 5712, 'a row the rerun re-read was not stamped as refreshed');
  assert.ok(refreshed.every((r) => !shifted.has(r.venue_id)), 'a row nobody asked about was stamped');
});

// ---------------------------------------------------------------------------
// The axis proof and its gate.
// ---------------------------------------------------------------------------
test('a six-hour origin error is caught: --commit refuses and writes nothing, the dry run exits nonzero', async () => {
  const before = await snapshot();
  const fixture = SHIFTED;
  const commit = await runHarvest(['--commit', '--city=philly'], fakeBestTime(fixture));
  assertNoKey(commit.out);
  assert.strictEqual(commit.summary.aborted, true);
  assert.strictEqual(commit.summary.exitCode, 1);
  assert.strictEqual(commit.summary.axis.bestShift, 6, 'the planted six-hour error is what the proof finds');
  assert.match(commit.out, /COMMIT GATE: REFUSED \(the curves agree best with the stored rows at a rotation of \+6 hours, not 0\)\. Judged by the within-five rule/);
  assert.match(commit.out, /ABORTED: REFUSED: the axis proof failed/);
  assert.match(commit.out, /\n +\+6 +4032 +0\.00 +100\.0% +100\.0% +1\.000 +24 +<- best/);
  assert.deepStrictEqual(await snapshot(), before, 'a refused commit wrote');

  const dry = await runHarvest(['--city=philly'], fakeBestTime(fixture));
  assert.strictEqual(dry.summary.aborted, false);
  assert.strictEqual(dry.summary.exitCode, 1, 'a dry run whose commit would be refused reported success');
  assert.match(dry.out, /The axis proof would refuse --commit: exiting nonzero/);
});

test('too few known venues to compare is a refusal, not a pass', async () => {
  const before = await snapshot();
  const { summary, out } = await runHarvest(['--commit', '--city=philly'], fakeBestTime([V.noPlace, ...AXIS.slice(0, 5)]));
  assert.strictEqual(summary.exitCode, 1);
  assert.strictEqual(summary.axis.venues, 5);
  assert.match(out, /COMMIT GATE: REFUSED \(only 5 known venues could be compared \(at least 20 are needed/);
  assert.deepStrictEqual(await snapshot(), before);
});

test('axisProof names the rotation, and the gate holds the floors', () => {
  const week = (seed) => harvester.weekCurve(harvester.weekCells(weekFor(seed).map((h, d) => [d, h])));
  const rotate = (c, k) => { const o = new Int16Array(168); for (let i = 0; i < 168; i++) o[(i + k + 168) % 168] = c[i]; return o; };
  const venues = (k, n = 25) => Array.from({ length: n }, (_, i) => { const c = week(i * 11); return { planned: rotate(c, k), stored: c }; });
  for (const k of [0, 6, -6, 24, -24, 1]) {
    const proof = harvester.axisProof(venues(k));
    assert.strictEqual(proof.bestShift, k, `rotation ${k}`);
    assert.strictEqual(harvester.axisVerdict(proof).pass, k === 0, `gate at rotation ${k}`);
  }
  // Flat and thin stored weeks are left out rather than voting.
  const flat = { planned: week(1), stored: new Int16Array(168).fill(40) };
  const thin = { planned: week(2), stored: new Int16Array(168).fill(-1).fill(30, 0, 10) };
  const p = harvester.axisProof([...venues(0, 20), flat, thin]);
  assert.deepStrictEqual([p.venues, p.flat, p.thin], [20, 1, 1]);
  assert.strictEqual(harvester.axisVerdict(harvester.axisProof(venues(0, 19))).pass, false, '19 venues prove nothing');
  // Rotation 0 best is not enough on its own: both floors hold.
  const at0 = (within5, venuesBestHere) => ({ venues: 100, bestShift: 0, table: [{ shift: 0, within5, venuesBestHere }] });
  assert.strictEqual(harvester.axisVerdict(at0(0.99, 90)).pass, true);
  assert.match(harvester.axisVerdict(at0(harvester.AXIS_MIN_WITHIN5 - 0.01, 90)).reason, /within five points/);
  assert.match(harvester.axisVerdict(at0(0.99, 100 * harvester.AXIS_MIN_VENUE_SHARE - 1)).reason, /agree best at rotation 0/);
});

// A proof table over every rotation of the week: `rows` overrides the default
// (a poor fit) at the shifts it names.
function proofTable({ venues, bestShift, rows }) {
  const table = [];
  for (let k = -83; k <= 84; k++) {
    table.push({ shift: k, pairs: 50000, mae: 30, exact: 0.02, within5: 0.15, r: 0.3, venuesBestHere: 0, ...(rows[k] || {}) });
  }
  return { venues, tied: 0, thin: 0, flat: 0, table, bestShift };
}

test('--new-only judges the hour origin alone: drifted stored curves pass, a real shift does not', () => {
  // Denver, 2026-11-18: rotation 0 best by every measure, 528 of 540 venues
  // best there, r 0.972 against 0.884 one hour off, and refused only because
  // its stored curves are months old (88.1% of cells within five points).
  const denverRows = {
    0: { mae: 2.49, exact: 0.78, within5: 0.881, r: 0.972, venuesBestHere: 528 },
    1: { mae: 6.1, exact: 0.3, within5: 0.55, r: 0.884, venuesBestHere: 2 },
    [-1]: { mae: 6.3, exact: 0.3, within5: 0.54, r: 0.879, venuesBestHere: 0 },
    24: { mae: 7.5, exact: 0.25, within5: 0.5, r: 0.86, venuesBestHere: 3 },
    [-24]: { mae: 7.6, exact: 0.25, within5: 0.5, r: 0.858, venuesBestHere: 2 },
  };
  const denver = proofTable({ venues: 540, bestShift: 0, rows: denverRows });
  const newOnly = harvester.axisVerdict(denver, { newOnly: true });
  assert.strictEqual(newOnly.pass, true, newOnly.reason);
  assert.match(newOnly.rule, /--new-only/);
  assert.match(newOnly.reason, /528 of 540 venues \(97\.8%\) fit best at rotation 0/);
  assert.match(newOnly.reason, /r 0\.972 is 0\.088 above the next rotation's \(\+1, 0\.884\)/);
  // A commit that refreshes known rows keeps the within-five rule.
  const refresh = harvester.axisVerdict(denver);
  assert.strictEqual(refresh.pass, false);
  assert.match(refresh.reason, /at rotation 0 only 88\.1% of cells are within five points \(at least 90\.0% needed\)/);
  assert.match(refresh.rule, /within-five rule/);

  // A real hour shift is refused under --new-only, whatever the drift.
  for (const k of [1, -6]) {
    const shifted = proofTable({
      venues: 540, bestShift: k,
      rows: { [k]: { mae: 2.4, within5: 0.95, r: 0.975, venuesBestHere: 530 }, 0: { mae: 6, within5: 0.6, r: 0.88, venuesBestHere: 1 } },
    });
    const v = harvester.axisVerdict(shifted, { newOnly: true });
    assert.strictEqual(v.pass, false, `rotation ${k}`);
    assert.match(v.reason, new RegExp(`rotation of ${k > 0 ? '\\+' : ''}${k} hours, not 0`));
  }
  // And each of the rule's three tests holds on its own.
  const share = proofTable({ venues: 540, bestShift: 0, rows: { ...denverRows, 0: { ...denverRows[0], venuesBestHere: 480 } } });
  assert.match(harvester.axisVerdict(share, { newOnly: true }).reason, /480 of 540 venues \(88\.9%\) fit best at rotation 0 \(at least 90\.0% needed\)/);
  const close = proofTable({ venues: 540, bestShift: 0, rows: { ...denverRows, [-1]: { ...denverRows[-1], r: 0.94 } } });
  assert.match(harvester.axisVerdict(close, { newOnly: true }).reason, /r 0\.972 is only 0\.032 above rotation -1's \(0\.940\); at least 0\.05 needed/);
  const few = proofTable({ venues: 19, bestShift: 0, rows: denverRows });
  assert.match(harvester.axisVerdict(few, { newOnly: true }).reason, /only 19 known venues could be compared/);
  const noR = proofTable({ venues: 540, bestShift: 0, rows: { ...denverRows, 0: { ...denverRows[0], r: null } } });
  assert.strictEqual(harvester.axisVerdict(noR, { newOnly: true }).pass, false);
});

test('the peak-hour histogram is on the venue clock', () => {
  // A bar busiest at BestTime slot 16 of every day: 22:00 local.
  const hours = Array.from({ length: 24 }, (_, s) => (s === 16 ? 90 : 10));
  const cells = harvester.weekCells([0, 1, 2, 3, 4, 5, 6].map((d) => [d, hours]));
  const h = harvester.peakHourHistogram([{ category: 'bar', cells }, { row: { venue_category: 'cafe' }, cells: [] }]);
  assert.strictEqual(h.get('bar')[22], 1);
  assert.strictEqual([...h.get('bar')].reduce((a, b) => a + b, 0), 1);
  assert.ok(!h.has('cafe'), 'a venue with no curve has no peak');
});

test('place ids are Google shapes, names are compared as names', () => {
  for (const id of ['ChIJgUbEo8cfqokR5lP9_Wh_DaM', 'GhIJQWDl0CIeQUARxks3icF8U8A', 'ChIJharvestKnownBt01']) {
    assert.ok(harvester.isRealGooglePlaceId(id), id);
  }
  for (const id of ['EicxMyBNYXJrZXQgU3QsIFdpbG1pbmd0b24sIE5DIDI4NDAxLCBVU0E', 'bt_ven_pseudo', 'ven_1234567890abcdef',
    'abcdefghijklmnop', 'ChIJshort', '', null, 'ChIJ has spaces in it here']) {
    assert.ok(!harvester.isRealGooglePlaceId(id), String(id));
  }
  const same = [['The Olde Bar', 'Olde Bar Philadelphia'], ["Joe's Pizza", 'Joes Pizza'], ['Starbucks', 'Starbucks Coffee'],
    ["Dave & Buster's", 'Dave and Busters'], ['Frankford Hall', 'Frankford Hall Beer Garden'], ['Café Lutèce', 'Cafe Lutece']];
  for (const [a, b] of same) assert.ok(harvester.namesSimilar(a, b), `${a} / ${b}`);
  const different = [['Sushi Palace', 'The Olde Bar'], ['Cafe', 'Cafe Lift'], ['Bar', 'Bar Hygge'], ['', 'Anything'],
    ['Philadelphia', 'Philly'], ['Pizza Hut', 'Pizza Brain']];
  for (const [a, b] of different) assert.ok(!harvester.namesSimilar(a, b), `${a} / ${b}`);
});

// ---------------------------------------------------------------------------
// Exit codes.
// ---------------------------------------------------------------------------
test('an empty run exits nonzero, dry or committed, through main() as well', async () => {
  const dry = await runHarvest([], fakeBestTime([]));
  assert.strictEqual(dry.summary.aborted, false);
  assert.strictEqual(dry.summary.exitCode, 1, 'a dry run that found nothing reported success');
  assert.match(dry.out, /Nothing to write: exiting nonzero/);
  const commit = await runHarvest(['--commit'], fakeBestTime([]));
  assert.strictEqual(commit.summary.exitCode, 1, 'a commit that wrote nothing reported success');

  const saved = { fetch: globalThis.fetch, log: console.log, warn: console.warn, error: console.error, exitCode: process.exitCode };
  const fake = fakeBestTime([]);
  globalThis.fetch = fake.fetchImpl;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    await harvester.main(['node', 'harvestVenueFilter.js', '--commit', '--days=0'], { pool, sleep: async () => {} });
    assert.strictEqual(process.exitCode, 1, 'main() left a zero exit code on an empty run');
  } finally {
    Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error });
    globalThis.fetch = saved.fetch;
    process.exitCode = saved.exitCode;
    ALL_REQUESTS.push(...fake.requests);
  }
});

test('a key refused mid-run aborts, writes nothing and exits nonzero', async () => {
  const before = await snapshot();
  const { summary, out } = await runHarvest(['--commit'], fakeBestTime(FIXTURE, { failDay: 3, failStatus: 402 }));
  assertNoKey(out);
  assert.strictEqual(summary.aborted, true);
  assert.strictEqual(summary.exitCode, 1);
  assert.match(out, /ABORTED: HTTP 402/);
  assert.match(out, /Account after/, 'an aborted run still shows the account afterwards');
  assert.deepStrictEqual(await snapshot(), before, 'an aborted run wrote');
});

test('a filter that ignores the day aborts rather than filing one weekday under another', async () => {
  const { summary, out } = await runHarvest(['--days=0,1'], fakeBestTime(FIXTURE, { ignoreDay: true }));
  assert.strictEqual(summary.aborted, true);
  assert.strictEqual(summary.exitCode, 1);
  assert.match(out, /not being honoured/);
});

test('bad arguments refuse before any request', async () => {
  for (const args of [['--city=atlantis'], ['--city=miami'], ['--city=beijing'], ['--city=all,nyc'], ['--days=7'],
    ['--page-size=600'], ['--frobnicate'], ['--radius-km=0'], ['--radius-km=81'], ['--result-budget=0'],
    ['--result-budget=50'], ['--result-budget=100001'], ['--max-requests=5']]) {
    const fake = fakeBestTime(FIXTURE);
    const { summary } = await runHarvest(args, fake);
    assert.strictEqual(summary.exitCode, 1, args.join(' '));
    assert.strictEqual(fake.requests.length, 0, `${args.join(' ')} made a request`);
  }
});

// ---------------------------------------------------------------------------
// Paging and tiling.
// ---------------------------------------------------------------------------
function cluster(count, lat, lng, spread) {
  return Array.from({ length: count }, (_, i) => fx(
    `ven_cluster_${i}`,
    spread ? lat + ((i % 25) / 25 - 0.5) * spread : lat,
    spread ? lng + (Math.floor(i / 25) / 24 - 0.5) * spread : lng,
    'BAR', null, i % 90
  ));
}
// The coarse tile holding Philadelphia's centroid, so a cluster sits wholly in
// one first-pass box.
const CENTER_TILE = harvester.buildTiles(['philly'], 20)
  .find((t) => t.s <= 39952 && t.n >= 39953 && t.w <= -75166 && t.e >= -75165);
const tileCenter = { lat: (CENTER_TILE.s + CENTER_TILE.n) / 2000, lng: (CENTER_TILE.w + CENTER_TILE.e) / 2000 };
const pagesFor = (requests, tile) => requests
  .filter((r) => r.path === '/api/v1/venues/filter'
    && r.params.lat_min === (tile.s / 1000).toFixed(3) && r.params.lng_min === (tile.w / 1000).toFixed(3)
    && r.params.lat_max === (tile.n / 1000).toFixed(3) && r.params.lng_max === (tile.e / 1000).toFixed(3))
  .map((r) => Number(r.params.page));

test('a box is paged up to the cap and no further, then split, and every venue is found', async () => {
  const fixture = cluster(600, tileCenter.lat, tileCenter.lng, 0.06);
  const fake = fakeBestTime(fixture);
  const { summary } = await runHarvest(['--city=philly', '--days=0'], fake);
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.deepStrictEqual(pagesFor(fake.requests, CENTER_TILE), [0, 1, 2, 3, 4],
    'the capped box was not paged exactly to the cap');
  const filter = fake.requests.filter((r) => r.path === '/api/v1/venues/filter');
  assert.ok(filter.every((r) => Number(r.params.page) < 5), 'a page past the cap was requested');
  assert.ok(filter.every((r) => r.params.limit === '100'));
  assert.strictEqual(summary.stats.splits, 1);
  assert.strictEqual(summary.stats.truncatedTiles, 0);
  assert.strictEqual(summary.venuesFound, 600, 'splitting lost venues');
});

test('when venues_n is the box total, a capped box is split without paging it', async () => {
  const fixture = cluster(600, tileCenter.lat, tileCenter.lng, 0.06);
  const fake = fakeBestTime(fixture, { reportTotal: true });
  const { summary } = await runHarvest(['--city=philly', '--days=0'], fake);
  assert.deepStrictEqual(pagesFor(fake.requests, CENTER_TILE), [0]);
  assert.strictEqual(summary.venuesFound, 600);
});

test('splitting stops at the minimum tile size and says the box is still capped', async () => {
  // Six hundred venues on one point cannot be separated by any split.
  const fixture = cluster(600, 39.95265, -75.16525, 0);
  const fake = fakeBestTime(fixture);
  const { summary, out } = await runHarvest(['--city=philly', '--days=0'], fake);
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.strictEqual(summary.stats.truncatedTiles, 1);
  assert.match(out, /minimum tile size/);
  assert.ok(summary.stats.requests < 400, `${summary.stats.requests} requests: the split did not terminate early`);
  const last = fake.requests.filter((r) => r.path === '/api/v1/venues/filter').at(-1);
  assert.ok(last, 'no filter request');
});

test('the request ceiling ends a runaway run nonzero', async () => {
  const fixture = cluster(600, 39.95265, -75.16525, 0);
  const { summary, out } = await runHarvest(['--city=philly', '--days=0', '--max-requests=20'], fakeBestTime(fixture));
  assert.strictEqual(summary.aborted, true);
  assert.strictEqual(summary.exitCode, 1);
  assert.strictEqual(summary.stats.requests, 20);
  assert.match(out, /--max-requests=20/);
});

// ---------------------------------------------------------------------------
// Every training city, --new-only and the result budget (2026-11-17).
// ---------------------------------------------------------------------------
const boxOf = (r) => ({
  s: Math.round(Number(r.params.lat_min) * 1000), w: Math.round(Number(r.params.lng_min) * 1000),
  n: Math.round(Number(r.params.lat_max) * 1000), e: Math.round(Number(r.params.lng_max) * 1000),
});
const boxKey = (t) => `${t.s},${t.w},${t.n},${t.e}`;
const inBox = (t, v) => v.lat >= t.s / 1000 && v.lat <= t.n / 1000 && v.lng >= t.w / 1000 && v.lng <= t.e / 1000;

test('--city takes any training city, and --city=all is every one but the holdouts and beijing', () => {
  const parse = (...a) => harvester.parseArgs(['node', 'harvestVenueFilter.js', ...a]);
  assert.deepStrictEqual(parse().cities, ['philly', 'lehigh'], 'no --city is still the two PA markets');
  assert.deepStrictEqual(parse('--city=nyc').cities, ['nyc']);
  assert.deepStrictEqual(parse('--city=london, denver,london').cities, ['london', 'denver']);
  const all = [
    'nyc', 'la', 'chicago', 'london', 'lehigh', 'sydney', 'delhi', 'paris', 'madrid', 'philly', 'dallas', 'austin',
    'seattle', 'denver', 'boston', 'nashville', 'nola', 'mexico', 'saopaulo', 'buenosaires', 'berlin', 'amsterdam',
    'rome', 'dubai', 'capetown', 'singapore', 'seoul', 'bangkok', 'mumbai', 'toronto',
  ];
  assert.deepStrictEqual(parse('--city=all').cities, all);
  // The same list derived, so a city added to config.js or to the holdout list
  // moves --city=all with it.
  assert.deepStrictEqual(all, Object.keys(CITIES).filter((c) => !HOLDOUT_CITIES.includes(c) && c !== 'beijing'));
  assert.deepStrictEqual(HOLDOUT_CITIES, ['miami', 'tokyo', 'barcelona']);
  for (const c of HOLDOUT_CITIES) {
    assert.match(parse(`--city=${c}`).error, new RegExp(`--city=${c} refused: ${c} is a holdout city \\(train/export_training_data\\.js HOLDOUT_CITIES\\)`));
    assert.match(parse(`--city=nyc,${c}`).error, /is a holdout city/, `${c} named beside another city`);
  }
  assert.match(parse('--city=beijing').error, /--city=beijing refused: beijing is not harvested: Google has no usable data in mainland China/);
  assert.match(parse('--city=all,nyc').error, /--city=all stands alone/);
  assert.match(parse('--city=atlantis').error, /config\.js CITIES keys, comma separated, or all; got "atlantis"/);
  assert.match(parse('--city=').error, /config\.js CITIES keys/);
  assert.strictEqual(parse().resultBudget, 60000);
  assert.strictEqual(parse('--result-budget=25000').resultBudget, 25000);
  assert.match(parse('--result-budget=100001').error, /--result-budget must be an integer from 1 to 100000/);
  assert.match(parse('--result-budget=50').error, /smaller than one page \(--page-size=100\)/);
  assert.strictEqual(parse('--result-budget=50', '--page-size=50').resultBudget, 50);
  assert.deepStrictEqual([parse().newOnly, parse('--new-only').newOnly], [false, true]);
});

test('a PA run asks the boxes it always asked, alone, together, or inside --city=all', () => {
  // The grids as the harvester built them before any other city could be
  // named (47257536): the boxes behind the September and November PA commits.
  const fp = (tiles) => crypto.createHash('sha256')
    .update(JSON.stringify(tiles.map((t) => [t.s, t.w, t.n, t.e]))).digest('hex').slice(0, 16);
  const sorted = (tiles) => tiles.slice().sort((a, b) => a.s - b.s || a.w - b.w);
  for (const [cities, radiusKm, n, hash] of [
    [['philly', 'lehigh'], 20, 14, 'ffb9448887e10c72'],
    [['philly'], 20, 8, '394df5a706baac06'],
    [['lehigh'], 20, 6, '6b5dc404d08aab4e'],
    [['philly', 'lehigh'], 80, 101, '27799eba818e09f4'],
    [['philly'], 80, 62, 'dbc660a73bf84e0c'],
    [['lehigh'], 80, 60, 'bae016c05c193819'],
  ]) {
    const what = `${cities.join('+')} at ${radiusKm} km`;
    const grid = harvester.buildTiles(cities, 20, radiusKm);
    assert.strictEqual(fp(grid), hash, `${what}: the grid moved`);
    const planned = harvester.planTiles(cities, 20, radiusKm);
    assert.strictEqual(planned.length, n, what);
    assert.strictEqual(fp(sorted(planned.map((p) => p.tile))), fp(sorted(grid)), `${what}: the run asks other boxes`);
    assert.ok(planned.every((p) => p.area.join() === cities.join()), `${what}: a split would keep other quarters`);
  }
  // Inside --city=all the two markets keep their shared grid, and nyc (124 km
  // from lehigh, 130 from philly) gets its own.
  const everything = harvester.planTiles(harvester.ALL_CITIES, 20, 20);
  const pa = everything.filter((p) => p.city === 'philly' || p.city === 'lehigh');
  assert.strictEqual(fp(sorted(pa.map((p) => p.tile))), fp(sorted(harvester.buildTiles(['philly', 'lehigh'], 20, 20))));
  // (config.js lists lehigh first; the grid does not depend on the order.)
  assert.ok(pa.every((p) => p.area.slice().sort().join() === 'lehigh,philly'));
  assert.deepStrictEqual(harvester.gridGroups(['nyc', 'philly', 'london', 'lehigh']), [['nyc'], ['philly', 'lehigh'], ['london']]);
  assert.strictEqual(harvester.gridGroups(harvester.ALL_CITIES).length, harvester.ALL_CITIES.length - 1,
    'only philly and lehigh are close enough to share a grid');
  // The centroids are config.js's, and PA_CITIES agrees with it for the two.
  const { PA_CITIES } = require('../scripts/ml/addDemandVenues');
  for (const c of ['philly', 'lehigh']) {
    assert.deepStrictEqual([CITIES[c].lat, CITIES[c].lon, CITIES[c].tz], [PA_CITIES[c].lat, PA_CITIES[c].lon, PA_CITIES[c].tz]);
  }
});

test('a non-PA city is tiled around its own CITIES centroid, and its whole circle is covered', () => {
  const { kmBetween } = require('../scripts/ml/addDemandVenues');
  for (const city of ['nyc', 'london', 'sydney', 'buenosaires']) {
    const c = CITIES[city];
    const planned = harvester.planTiles([city], 20, 20);
    assert.ok(planned.length >= 4, `${city}: ${planned.length} boxes`);
    assert.ok(planned.every((p) => p.city === city && p.area.join() === city));
    for (const p of planned) assert.ok(harvester.tileIntersects(p.tile, [city], 20), `${city}: a box off the circle`);
    // Points on a 1 km lattice across the circle: every one inside some box.
    const dLat = 20 / 111.32;
    const dLng = 20 / (111.32 * Math.cos((c.lat * Math.PI) / 180));
    let inside = 0;
    for (let i = -20; i <= 20; i++) {
      for (let j = -20; j <= 20; j++) {
        const pt = { lat: c.lat + (i / 20) * dLat, lng: c.lon + (j / 20) * dLng };
        if (kmBetween(c.lat, c.lon, pt.lat, pt.lng) > 19.9) continue;
        inside++;
        assert.ok(planned.some((p) => inBox(p.tile, pt)), `${city}: ${pt.lat},${pt.lng} is in no box`);
      }
    }
    assert.ok(inside > 1000);
  }
});

test('where a venue belongs: the PA rule first, then the nearest city asked for or refused', () => {
  const markets = harvester.otherMarkets(['nyc']);
  assert.deepStrictEqual(Object.keys(markets).sort(), ['barcelona', 'beijing', 'miami', 'nyc', 'tokyo']);
  assert.strictEqual(harvester.placeVenue(40.73, -73.99, markets).cityKey, 'nyc');
  // 75 km from philly and 74 from nyc: the PA market rule keeps it philly's,
  // in every run, as addDemandVenues would file it.
  assert.strictEqual(nearestPaCity(40.088, -74.303).cityKey, 'philly');
  assert.strictEqual(harvester.placeVenue(40.088, -74.303, harvester.otherMarkets(harvester.ALL_CITIES)).cityKey, 'philly');
  assert.strictEqual(harvester.placeVenue(25.77, -80.19, markets).cityKey, 'miami');
  assert.strictEqual(harvester.placeVenue(0, 0, markets).cityKey, null);

  const days = new Map([[0, new Array(24).fill(30)]]);
  const v = (venueId, lat, lng) => ({ venueId, placeId: `ChIJplacement${venueId}xxxxxxx`, name: `Place ${venueId}`, lat, lng, type: 'BAR', days });
  const { plan, skipped, placed } = harvester.planVenues(
    [v('ven_p_nyc', 40.73, -73.99), v('ven_p_phl', 40.088, -74.303), v('ven_p_mia', 25.77, -80.19), v('ven_p_sea', 0, 0)],
    { byBtId: new Map(), byPlaceId: new Map(), nearby: [] }, ['nyc']
  );
  assert.deepStrictEqual(plan.map((p) => [p.venue.venueId, p.city, p.kind]), [['ven_p_nyc', 'nyc', 'new']]);
  assert.strictEqual(skipped.otherMarket, 2, "philly's and miami's venues are theirs, not nyc's");
  assert.strictEqual(skipped.outsideMarkets, 1);
  assert.deepStrictEqual([...placed], [['nyc', 1]]);
});

test('a nyc run asks only about nyc, and places its new venues there', async () => {
  const NYC = [
    fx('ven_nyc_bar', 40.7301, -73.9901, 'BAR', 'ChIJharvestNycBar0001', 12, { name: 'Nyc Test Bar' }),
    fx('ven_nyc_cafe', 40.7001, -74.0101, 'CAFE', 'ChIJharvestNycCafe001', 22, { name: 'Nyc Test Cafe' }),
    fx('ven_nyc_rest', 40.7501, -73.9801, 'RESTAURANT', 'ChIJharvestNycRest001', 32, { name: 'Nyc Test Kitchen' }),
  ];
  const before = await snapshot();
  const fake = fakeBestTime([...NYC, V.newPhilly]);
  const { summary, out } = await runHarvest(['--city=nyc'], fake);
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.deepStrictEqual(summary.plan, { known_bt: 0, known_place: 0, known_near: 0, new: 3 });
  assert.strictEqual(summary.rowsPlanned, 3 * 168);
  assert.strictEqual(summary.exitCode, 1, 'no known venue to prove the axis with: a commit would be refused');
  assert.match(out, /The axis proof would refuse --commit/);
  const filters = fake.requests.filter((r) => r.path === '/api/v1/venues/filter');
  const planned = new Set(harvester.planTiles(['nyc'], 20, 20).map((p) => boxKey(p.tile)));
  assert.strictEqual(filters.length, planned.size * 7);
  for (const r of filters) {
    assert.ok(planned.has(boxKey(boxOf(r))), `a box nyc's grid does not hold: ${boxKey(boxOf(r))}`);
    assert.ok(!harvester.tileIntersects(boxOf(r), ['philly', 'lehigh'], 80), 'a nyc run asked about PA');
  }
  const nyc = summary.byCity.nyc;
  assert.deepStrictEqual([nyc.state, nyc.tiles, nyc.requests, nyc.results, nyc.venues, nyc.newPlanned, nyc.rowsPlanned],
    ['done', planned.size, planned.size * 7, 3 * 7, 3, 3, 3 * 168]);
  assert.match(out, new RegExp(`nyc: ${planned.size} tiles \\(${planned.size} leaves\\), ${planned.size * 7} requests, 21 results`));
  assert.match(out, /BY CITY \(dry run/);
  assert.match(out, new RegExp(`\\n  nyc +${planned.size} +${planned.size * 7} +21 +3 +3 +0 +0 +504\\n`));
  assert.deepStrictEqual(await snapshot(), before, 'the dry run wrote');
});

test('--city=all asks every training city around its own centroid, and nothing near a refused one', async () => {
  const fake = fakeBestTime([]);
  const { summary, out } = await runHarvest(['--city=all', '--days=0'], fake);
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  const planned = harvester.planTiles(harvester.ALL_CITIES, 20, 20);
  const boxes = fake.requests.filter((r) => r.path === '/api/v1/venues/filter').map(boxOf);
  assert.deepStrictEqual(boxes.map(boxKey), planned.map((p) => boxKey(p.tile)), 'city by city, each on its own grid');
  for (const p of planned) assert.ok(harvester.tileIntersects(p.tile, [p.city], 20), `${p.city}: a box off its circle`);
  for (const b of boxes) assert.ok(!harvester.tileIntersects(b, Object.keys(harvester.REFUSED_CITIES), 80), 'a refused city was asked about');
  assert.deepStrictEqual(Object.keys(summary.byCity), harvester.ALL_CITIES);
  assert.ok(harvester.ALL_CITIES.every((c) => summary.byCity[c].state === 'done' && summary.byCity[c].tiles > 0));
  assert.match(out, new RegExp(`${planned.length} tiles of about 20 km cover nyc \\+ la \\+ chicago`));
  assert.match(out, /\n  toronto +\d+ tiles, at least \d+ requests/);
  assert.match(out, /Nothing to write: exiting nonzero/);
});

test('--new-only writes nothing for a venue already held, and a new one gets its own city and zone', async () => {
  // London, so the new row's timezone is not the default New York one.
  const pad = (i) => String(i).padStart(3, '0');
  const LAXIS = Array.from({ length: 24 }, (_, i) => fx(
    `ven_lon_axis_${pad(i)}`, 51.4900 + i * 0.001, -0.1500, 'BAR', `ChIJharvestLonAxis${pad(i)}`, 400 + i * 3
  ));
  const L = {
    knownBt: fx('ven_lon_known_bt', 51.5150, -0.1000, 'BAR', 'ChIJharvestLonKnownB1', 11),
    knownPlace: fx('ven_lon_known_place', 51.5160, -0.0900, 'RESTAURANT', 'ChIJharvestLonKnownP1', 21),
    nearDup: fx('ven_lon_near_dup', 51.50695, -0.19460, 'BAR', 'ChIJharvestLonNearNw1', 31, { name: 'Churchill Arms London' }),
    fresh: fx('ven_lon_new', 51.5200, -0.0800, 'CAFE', 'ChIJharvestLonNewCaf1', 41, { name: 'Lantern Coffee' }),
  };
  const london = { city: 'london', tz: 'Europe/London' };
  for (const [i, v] of LAXIS.entries()) {
    await insertVenue(`lonAxis${i}`, v.placeId, v.venueId, 'bar', { ...london, lat: v.lat, lng: v.lng });
    await storeWeek(seeded[`lonAxis${i}`], v);
  }
  await insertVenue('lonKnownBt', 'ChIJharvestLonKnownB1', 'ven_lon_known_bt', 'bar', { ...london, lat: 51.5150, lng: -0.1000 });
  await insertVenue('lonKnownPlace', 'ChIJharvestLonKnownP1', null, 'restaurant', { ...london, lat: 51.5160, lng: -0.0900 });
  await insertVenue('lonNearRow', 'ChIJharvestLonNearRw1', null, 'bar',
    { ...london, name: 'The Churchill Arms', lat: 51.50680, lng: -0.19450 });
  // A stored Tuesday 20:00 the harvest would read as 49: it must stay 99.
  await pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
                                   busyness_pct, besttime_epoch, events_observed, events_unavailable_reason)
     VALUES ($1, 'weekly', 'venue_local', 2, 20, 'bar', 99, 1786000000, false, 'no_observation_date')`,
    [seeded.lonKnownBt]
  );
  const fixture = [...LAXIS, ...Object.values(L)];
  const knownIds = [...LAXIS.map((_, i) => seeded[`lonAxis${i}`]), seeded.lonKnownBt, seeded.lonKnownPlace, seeded.lonNearRow];
  const held = async () => {
    const { rows: venues } = await pool.query('SELECT *, xmin::text AS xm FROM ml_venues WHERE id = ANY($1) ORDER BY id', [knownIds]);
    const { rows: training } = await pool.query(
      'SELECT *, xmin::text AS xm FROM ml_training_data WHERE venue_id = ANY($1) ORDER BY id', [knownIds]
    );
    return { venues, training };
  };
  const heldBefore = await held();
  assert.strictEqual(heldBefore.training.length, 24 * 168 + 1);

  const dry = await runHarvest(['--city=london', '--new-only'], fakeBestTime(fixture));
  assert.strictEqual(dry.summary.exitCode, 0, dry.summary.abortReason);
  assert.deepStrictEqual(dry.summary.plan, { known_bt: 25, known_place: 1, known_near: 1, new: 1 });
  assert.strictEqual(dry.summary.knownSkipped, 27);
  assert.strictEqual(dry.summary.rowsPlanned, 168, 'only the new venue\'s week is planned');
  assert.match(dry.out, /NEW VENUES ONLY/);
  assert.match(dry.out, /COMMIT GATE: PASS \(best rotation 0; 24 of 24 venues \(100\.0%\) fit best at rotation 0; .*\)\. Judged by the --new-only hour-origin rule/);
  assert.match(dry.out, /--new-only: 27 known venues skipped \(25 by BestTime id, 1 by Google place id, 1 as near-duplicates\)/);
  assert.match(dry.out, /Would write 168 weekly rows for 1 venues and add 1 ml_venues rows .* 27 known venues skipped \(--new-only\)\./);

  const { summary, out } = await runHarvest(['--city=london', '--new-only', '--commit'], fakeBestTime(fixture));
  assertNoKey(out);
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.strictEqual(summary.exitCode, 0);
  // The proof read the 24 known weeks it writes nothing to.
  assert.strictEqual(summary.axis.venues, 24);
  assert.strictEqual(summary.axisVerdict.pass, true, summary.axisVerdict.reason);
  assert.deepStrictEqual([summary.venuesWritten, summary.venuesInserted, summary.rowsWritten, summary.rowsRefreshed],
    [1, 1, 168, 0]);
  assert.strictEqual(summary.knownSkipped, 27);
  const lon = summary.byCity.london;
  assert.deepStrictEqual([lon.newWritten, lon.knownWritten, lon.knownSkipped, lon.rowsWritten], [1, 0, 27, 168]);
  assert.match(out, /\n  london +\d+ +\d+ +\d+ +28 +1 +0 +27 +168\n/);

  // Not a byte of what was held moved: same rows, same versions.
  assert.deepStrictEqual(await held(), heldBefore, 'a known venue or one of its weekly rows was written');
  const { rows: stale } = await pool.query(
    'SELECT busyness_pct FROM ml_training_data WHERE venue_id = $1 AND day_of_week = 2 AND hour = 20', [seeded.lonKnownBt]
  );
  assert.deepStrictEqual(stale.map((r) => r.busyness_pct), [99]);
  const { rows: twins } = await pool.query(
    "SELECT 1 FROM ml_venues WHERE besttime_venue_id IN ('ven_lon_known_place', 'ven_lon_near_dup') OR google_place_id = 'ChIJharvestLonNearNw1'"
  );
  assert.deepStrictEqual(twins, [], 'a known venue was given a second identity');

  const { rows: [fresh] } = await pool.query("SELECT * FROM ml_venues WHERE besttime_venue_id = 'ven_lon_new'");
  assert.deepStrictEqual(
    [fresh.google_place_id, fresh.city, fresh.timezone, fresh.venue_category, fresh.is_active, fresh.besttime_status],
    ['ChIJharvestLonNewCaf1', 'london', 'Europe/London', 'cafe', false, harvester.HARVEST_STATUS]
  );
  const { rows } = await pool.query(
    'SELECT day_of_week, hour, busyness_pct, collection_mode, hour_axis FROM ml_training_data WHERE venue_id = $1', [fresh.id]
  );
  assert.strictEqual(rows.length, 168);
  const expected = new Map();
  for (let d = 0; d < 7; d++) {
    for (let s = 0; s < 24; s++) {
      const local = bestTimeSlotToLocal(s, bestTimeDayToJsDay(d));
      expected.set(`${local.dayOfWeek}:${local.hour}`, L.fresh.week[d][s]);
    }
  }
  for (const r of rows) {
    assert.strictEqual(r.busyness_pct, expected.get(`${r.day_of_week}:${r.hour}`), `day ${r.day_of_week} hour ${r.hour}`);
    assert.deepStrictEqual([r.collection_mode, r.hour_axis], ['weekly', 'venue_local']);
  }
});

test('--new-only still refuses a --commit the axis proof fails', async () => {
  const before = await snapshot();
  const { summary, out } = await runHarvest(['--commit', '--new-only', '--city=philly'], fakeBestTime(SHIFTED));
  assert.strictEqual(summary.aborted, true);
  assert.strictEqual(summary.exitCode, 1);
  assert.strictEqual(summary.axis.bestShift, 6);
  assert.match(out, /ABORTED: REFUSED: the axis proof failed/);
  assert.deepStrictEqual(await snapshot(), before, 'a refused --new-only commit wrote');
});

test('the result budget stops the run before it could pass, and keeps every written week whole', async () => {
  // Philly's boxes in run order. The 24 known axis venues sit in an early box;
  // three clusters of ten new venues go in three later ones, A and B to be
  // finished, and C to be cut short by the budget two days into its week.
  const order = harvester.planTiles(['philly', 'lehigh'], 20, 20).filter((p) => p.city === 'philly').map((p) => p.tile);
  const lastAxis = Math.max(...order.map((t, i) => (AXIS.some((v) => inBox(t, v)) ? i : -1)));
  const c0 = harvester.CENTROIDS.philly;
  const usable = order.slice(lastAxis + 1).filter((t) => t.n - t.s >= 40 && t.e - t.w >= 40);
  assert.ok(usable.length >= 3, 'the philly grid has three boxes after the axis venues');
  const clusterIn = (tag, t) => {
    // The point of the box nearest philly's centroid, 15 thousandths inside.
    const lat = Math.min(Math.max(c0.lat, (t.s + 15) / 1000), (t.n - 15) / 1000);
    const lng = Math.min(Math.max(c0.lon, (t.w + 15) / 1000), (t.e - 15) / 1000);
    return Array.from({ length: 10 }, (_, i) => fx(
      `ven_budget_${tag}_${i}`, lat + (i - 5) * 0.001, lng, 'BAR', `ChIJharvestBudget${tag}${String(i).padStart(3, '0')}`,
      7 + i, { name: `Budget ${tag} Bar ${i}` }
    ));
  };
  const [A, B, C] = [clusterIn('A', usable[0]), clusterIn('B', usable[1]), clusterIn('C', usable[2])];
  const fixture = [...AXIS, ...A, ...B, ...C];
  for (const v of [...A, ...B, ...C]) assert.ok(nearestPaCity(v.lat, v.lng).km < 19, 'a cluster venue sits past the radius');
  const cAt = order.indexOf(usable[2]);
  // A week of every box before C, then C's first two days: the third would
  // need a page the budget no longer has room for.
  const before = 7 * order.slice(0, cAt).reduce((n, t) => n + fixture.filter((v) => inBox(t, v)).length, 0);
  const budget = before + 100 + 15;

  const { summary, out } = await runHarvest(
    ['--city=philly,lehigh', '--new-only', '--commit', `--result-budget=${budget}`], fakeBestTime(fixture)
  );
  assertNoKey(out);
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.strictEqual(summary.exitCode, 0, 'a budget stop with whole weeks written is a clean run');
  assert.deepStrictEqual(summary.budget, {
    limit: budget, used: before + 20, reserved: 0, stopped: true, cutShort: 'philly', unfinished: ['philly', 'lehigh'],
  });
  assert.ok(summary.stats.venuesReturned <= budget);
  assert.strictEqual(summary.venuesFound, 24 + 20, "C's venues were dropped with its box");
  assert.strictEqual(summary.incompleteWeeks, 0);
  assert.strictEqual(summary.venuesInserted, 20);
  assert.strictEqual(summary.rowsWritten, 20 * 168);
  assert.strictEqual(summary.knownSkipped, 24);
  assert.deepStrictEqual([summary.byCity.philly.state, summary.byCity.lehigh.state], ['stopped', 'not reached']);
  assert.deepStrictEqual([summary.byCity.philly.results, summary.byCity.lehigh.results, summary.byCity.lehigh.requests],
    [before + 20, 0, 0]);
  assert.match(out, new RegExp(`RESULT BUDGET: stopped in philly with ${before + 20} of ${budget} results used`));
  assert.match(out, /To continue, with what the month has left: --city=philly,lehigh/);
  assert.match(out, /\n  philly \(stopped\) /);
  assert.match(out, /\n  lehigh \(not reached\) /);

  const { rows } = await pool.query(
    `SELECT v.besttime_venue_id AS id, COUNT(t.id)::int AS n FROM ml_venues v LEFT JOIN ml_training_data t ON t.venue_id = v.id
      WHERE v.besttime_venue_id LIKE 'ven_budget_%' GROUP BY 1 ORDER BY 1`
  );
  assert.deepStrictEqual(rows.map((r) => r.id), [...A, ...B].map((v) => v.venueId).sort());
  assert.ok(rows.every((r) => r.n === 168), 'a venue was written with part of its week');
});

// Last, over every request every run above made.
test('across every run, only the venue filter and the key endpoint were called, and only by GET', () => {
  assert.ok(ALL_REQUESTS.length > 1000, 'the runs above made too few requests to prove anything');
  for (const r of ALL_REQUESTS) {
    assert.strictEqual(r.method, 'GET', `${r.method} ${r.path}`);
    assert.ok(r.path === '/api/v1/venues/filter' || r.path.startsWith('/api/v1/keys/'), r.path);
    for (const p of ['live', 'live_refresh', 'venue_name', 'venue_address', 'venue_id']) {
      assert.ok(!(p in r.params), `a filter request carried ${p}`);
    }
  }
  const filters = ALL_REQUESTS.filter((r) => r.path === '/api/v1/venues/filter');
  assert.ok(filters.every((r) => r.params.own_venues_only === 'False' && r.params.foot_traffic === 'day'));
  assert.ok(filters.every((r) => /^\d+\.\d{3}$/.test(r.params.lat_min.replace('-', ''))), 'more than three decimals sent');
});

// ---------------------------------------------------------------------------
// A review of the harvester after its first real runs, 2026-09-29.
// ---------------------------------------------------------------------------

test('an exact place id claims its row before a similar name nearby can', () => {
  // "Cafe Lift Annex" (lower BestTime id, 20 m away, a different place id) used
  // to take the row first; "Cafe Lift", whose place id IS that row, was skipped
  // as placeClaimedTwice and the Annex's curves were filed under Cafe Lift.
  const lat = tileCenter.lat;
  const lng = tileCenter.lng;
  const days = new Map([[0, new Array(24).fill(10)]]);
  const row = { id: 7, name: 'Cafe Lift', latitude: lat, longitude: lng, besttime_venue_id: null };
  const annex = { venueId: 'ven_a', placeId: 'ChIJannexannexannex', name: 'Cafe Lift Annex', lat: lat + 0.00018, lng, type: 'cafe', days };
  const lift = { venueId: 'ven_b', placeId: 'ChIJliftliftliftlift', name: 'Cafe Lift', lat, lng, type: 'cafe', days };
  const identities = { byBtId: new Map(), byPlaceId: new Map([[lift.placeId, row]]), nearby: [row] };
  const { plan, skipped } = harvester.planVenues([annex, lift], identities, ['philly']);
  const onRow = plan.filter((p) => p.row && p.row.id === 7);
  assert.strictEqual(onRow.length, 1);
  assert.strictEqual(onRow[0].kind, 'known_place');
  assert.strictEqual(onRow[0].venue.venueId, 'ven_b', 'the near name took the exact match\'s row');
  assert.strictEqual(skipped.placeClaimedTwice, 0);
  assert.strictEqual(skipped.nearDupClaimed, 1);
});

test('a redirect from the venue filter is not followed, and the run stops', async () => {
  // The guard approves the address asked for; a followed redirect is a request
  // it never saw, and could be one that spends an admission.
  const fake = fakeBestTime(cluster(5, tileCenter.lat, tileCenter.lng, 0.01));
  const inner = fake.fetchImpl;
  const redirectModes = [];
  fake.fetchImpl = async (input, init = {}) => {
    if (new URL(String(input)).pathname === '/api/v1/venues/filter') {
      redirectModes.push(init.redirect);
      return jsonResponse(302, {});
    }
    return inner(input, init);
  };
  const { summary } = await runHarvest(['--city=philly', '--days=0'], fake);
  assert.strictEqual(summary.aborted, true);
  assert.match(summary.abortReason, /redirect, which is not followed/);
  assert.ok(redirectModes.length > 0 && redirectModes.every((m) => m === 'manual'), `redirect modes: ${redirectModes}`);
});

test('a box that cannot be split is paged to the cap even when page one reports a bigger total', async () => {
  // Six hundred venues on one point with venues_n as the box total: the old
  // early stop kept page 0's hundred of a box that could never be split.
  const fixture = cluster(600, 39.95265, -75.16525, 0);
  const fake = fakeBestTime(fixture, { reportTotal: true });
  const { summary } = await runHarvest(['--city=philly', '--days=0'], fake);
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.strictEqual(summary.venuesFound, 500, 'the unsplittable box was not paged to the cap');
  assert.strictEqual(summary.stats.truncatedTiles, 1);
});

test('a new venue re-checks the near-duplicate rule under the write lock', async () => {
  const queries = [];
  const client = {
    query: async (sql) => {
      const text = String(sql);
      queries.push(text);
      if (/latitude BETWEEN/.test(text)) {
        return { rows: [{ id: 9, name: 'Cafe Lift', latitude: 39.9526, longitude: -75.1652 }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const fakePool = { connect: async () => client };
  const item = {
    kind: 'new',
    city: 'philly',
    category: 'cafe',
    venue: { venueId: 'ven_new', placeId: 'ChIJnewnewnewnewnew', name: 'Cafe Lift', lat: 39.95262, lng: -75.16522, address: null, rating: null, reviews: null },
  };
  const res = await harvester.writeOne(fakePool, item, []);
  assert.strictEqual(res.status, 'claimed');
  assert.ok(!queries.some((q) => /INSERT INTO ml_venues/.test(q)), 'a second row was inserted for a venue that already has one');
});

test('the key-status read does not follow redirects either', async () => {
  // Every request the harvest makes passes the admission guard as the address
  // it asked for; the key endpoint's read is one of them, and before and after
  // an abort it runs twice.
  const { fetchKeyStatus } = require('../services/besttimeAccount');
  const saved = globalThis.fetch;
  const modes = [];
  globalThis.fetch = async (url, init = {}) => { modes.push(init.redirect); return jsonResponse(302, {}); };
  try {
    const answer = await fetchKeyStatus('test-key');
    assert.deepStrictEqual(answer, { ok: false, kind: 'http', httpStatus: 302 });
    assert.deepStrictEqual(modes, ['manual']);
  } finally {
    globalThis.fetch = saved;
  }
});

test('the demand list inserts under the same corpus lock the harvest writes under', () => {
  // So a harvest re-checking for a near-duplicate and a demand insert of the
  // same place under another Google listing cannot interleave.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'scripts', 'ml', 'addDemandVenues.js'), 'utf8');
  assert.match(src, /withCorpusWriteLock\(pool, \(client\) => client\.query\(\s*`INSERT INTO ml_venues/);
  assert.doesNotMatch(src, /await pool\.query\(\s*`INSERT INTO ml_venues/);
});

// ---------------------------------------------------------------------------
// A review of the every-city harvest, 2026-11-18.
// ---------------------------------------------------------------------------

test('names in any script are compared, and the city a listing appends is not part of its name', () => {
  // The old key kept only a-z and 0-9, so every Hangul, Thai or Arabic name
  // came out empty and "not similar" to itself, and only the PA city words were
  // dropped, so "The Ivy London" was not "The Ivy".
  const same = [
    ['달빛 포차', '달빛 포차'], ['달빛포차', '달빛 포차'],
    ['ร้านกาแฟ ดอยช้าง', 'ร้านกาแฟ ดอยช้าง'], ['ร้านกาแฟดอยช้าง', 'ร้านกาแฟ ดอยช้าง'],
    ['مطعم الشام', 'مطعم الشام'], ['مطعم الشام', 'مطعم-الشام'],
  ];
  for (const [a, b] of same) assert.ok(harvester.namesSimilar(a, b), `${a} / ${b}`);
  const sameInCity = [
    ['The Ivy', 'The Ivy London', 'london'], ['Joe Bar', 'Joe Bar Buenos Aires', 'buenosaires'],
    ['Joe Bar', 'Joe Bar New York City', 'nyc'], ['Joe Bar', 'Joe Bar NYC', 'nyc'], ['Joe Bar', 'Joe Bar, New York', 'nyc'],
    ['Joe Bar', 'Joe Bar Mexico City', 'mexico'], ['Café Lutèce', 'Cafe Lutece São Paulo', 'saopaulo'],
    ['달빛 포차', '달빛 포차 서울', 'seoul'], ['Olde Bar', 'Olde Bar Philadelphia', 'philly'], ['London', 'London', 'london'],
  ];
  for (const [a, b, city] of sameInCity) assert.ok(harvester.namesSimilar(a, b, city), `${a} / ${b} in ${city}`);
  const different = [
    ['달빛 포차', '새벽 커피'], ['ร้านกาแฟ ดอยช้าง', 'ก๋วยเตี๋ยวเรือ'], ['مطعم الشام', 'مقهى بيروت'],
    ['달빛 포차', ''], ['★', '★'],
  ];
  for (const [a, b] of different) assert.ok(!harvester.namesSimilar(a, b), `${a} / ${b}`);
  // Nothing else is loosened: another city's name, a lone word of a two-word
  // city, a city named without its city, and a name that is only a city.
  const differentInCity = [
    ['The Ivy', 'The Ivy London', null], ['The Ivy', 'The Ivy London', 'paris'], ['Joe Bar', 'Joe Bar Aires Buenos', 'buenosaires'],
    ['The Ivy', 'The Ivy Chelsea Garden', 'london'], ['London', 'Paris', 'london'], ['The London', 'London Bridge Bar', 'london'],
    ['Sushi Palace', 'The Olde Bar', 'london'], ['Cafe', 'Cafe Lift', 'nyc'], ['Bar', 'La Bar', 'la'],
  ];
  for (const [a, b, city] of differentInCity) assert.ok(!harvester.namesSimilar(a, b, city), `${a} / ${b} in ${city}`);
});

test('the planner and the write lock judge names in the venue\'s own script and city', async () => {
  const days = new Map([[0, new Array(24).fill(10)]]);
  // Rule 4: "The Ivy London" 10 m from the corpus's "The Ivy" is that row.
  const ivyRow = { id: 41, name: 'The Ivy', latitude: 51.5126, longitude: -0.1281, besttime_venue_id: null };
  const ivy = { venueId: 'ven_ivy', placeId: 'ChIJivyivyivyivyivy1', name: 'The Ivy London', lat: 51.51269, lng: -0.1281, type: 'RESTAURANT', days };
  const ruled = harvester.planVenues([ivy], { byBtId: new Map(), byPlaceId: new Map(), nearby: [ivyRow] }, ['london']);
  assert.deepStrictEqual(ruled.plan.map((p) => [p.kind, p.row && p.row.id]), [['known_near', 41]]);

  // The in-run twin check: two new listings of one Thai cafe, 15 m apart.
  const thaiA = { venueId: 'ven_th_a', placeId: 'ChIJthaithaithaithai1', name: 'ร้านกาแฟ ดอยช้าง', lat: 13.7563, lng: 100.5018, type: 'CAFE', days };
  const thaiB = { ...thaiA, venueId: 'ven_th_b', placeId: 'ChIJthaithaithaithai2', name: 'ร้านกาแฟดอยช้าง', lat: 13.75643 };
  const twins = harvester.planVenues([thaiB, thaiA], { byBtId: new Map(), byPlaceId: new Map(), nearby: [] }, ['bangkok']);
  assert.deepStrictEqual(twins.plan.map((p) => [p.kind, p.venue.venueId]), [['new', 'ven_th_a']]);
  assert.strictEqual(twins.skipped.nearDuplicateInRun, 1);

  // Under the write lock: a row another writer added since the plan, a few
  // metres off, under the same Arabic name.
  const queries = [];
  const client = {
    query: async (sql) => {
      const text = String(sql);
      queries.push(text);
      if (/latitude BETWEEN/.test(text)) return { rows: [{ id: 9, name: 'مطعم الشام', latitude: 25.2048, longitude: 55.2708 }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const res = await harvester.writeOne({ connect: async () => client }, {
    kind: 'new', city: 'dubai', category: 'restaurant',
    venue: { venueId: 'ven_dxb', placeId: 'ChIJdubaidubaidubai01', name: 'مطعم الشام', lat: 25.20482, lng: 55.27082, address: null, rating: null, reviews: null },
  }, []);
  assert.strictEqual(res.status, 'claimed');
  assert.ok(!queries.some((q) => /INSERT INTO ml_venues/.test(q)), 'a second row was inserted under the same Arabic name');
});

test('--new-only writes nothing for a held Seoul venue that comes back under new ids with its Hangul name', async () => {
  const pad = (i) => String(i).padStart(3, '0');
  const SAXIS = Array.from({ length: 24 }, (_, i) => fx(
    `ven_seo_axis_${pad(i)}`, 37.5500 + i * 0.001, 126.9500, 'BAR', `ChIJharvestSeoAxis${pad(i)}`, 500 + i * 3
  ));
  const S = {
    // Seven metres from the held row, a new BestTime id and a new place id.
    twin: fx('ven_seo_twin', 37.57105, 126.98105, 'BAR', 'ChIJharvestSeoTwinPl1', 33, { name: '달빛 포차' }),
    fresh: fx('ven_seo_new', 37.5800, 126.9900, 'CAFE', 'ChIJharvestSeoNewCaf1', 43, { name: '새벽 커피' }),
  };
  const seoul = { city: 'seoul', tz: 'Asia/Seoul' };
  for (const [i, v] of SAXIS.entries()) {
    await insertVenue(`seoAxis${i}`, v.placeId, v.venueId, 'bar', { ...seoul, lat: v.lat, lng: v.lng });
    await storeWeek(seeded[`seoAxis${i}`], v);
  }
  await insertVenue('seoHeld', 'ChIJharvestSeoHeldPl1', null, 'bar', { ...seoul, name: '달빛 포차', lat: 37.57100, lng: 126.98100 });
  const heldIds = [seeded.seoHeld, ...SAXIS.map((_, i) => seeded[`seoAxis${i}`])];
  const held = async () => {
    const { rows: venues } = await pool.query('SELECT *, xmin::text AS xm FROM ml_venues WHERE id = ANY($1) ORDER BY id', [heldIds]);
    const { rows: training } = await pool.query(
      'SELECT *, xmin::text AS xm FROM ml_training_data WHERE venue_id = ANY($1) ORDER BY id', [heldIds]
    );
    return { venues, training };
  };
  const heldBefore = await held();
  const fixture = [...SAXIS, ...Object.values(S)];

  const dry = await runHarvest(['--city=seoul', '--new-only'], fakeBestTime(fixture));
  assert.strictEqual(dry.summary.exitCode, 0, dry.summary.abortReason);
  assert.deepStrictEqual(dry.summary.plan, { known_bt: 24, known_place: 0, known_near: 1, new: 1 });

  const { summary } = await runHarvest(['--city=seoul', '--new-only', '--commit'], fakeBestTime(fixture));
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.strictEqual(summary.exitCode, 0);
  assert.deepStrictEqual([summary.venuesInserted, summary.rowsWritten, summary.knownSkipped], [1, 168, 25]);
  assert.deepStrictEqual(await held(), heldBefore, 'the held venue or a known week was written');
  const { rows: second } = await pool.query(
    "SELECT 1 FROM ml_venues WHERE besttime_venue_id = 'ven_seo_twin' OR google_place_id = 'ChIJharvestSeoTwinPl1'"
  );
  assert.deepStrictEqual(second, [], 'the held Seoul venue was given a second identity');
  const { rows: [fresh] } = await pool.query("SELECT city, timezone FROM ml_venues WHERE besttime_venue_id = 'ven_seo_new'");
  assert.deepStrictEqual([fresh.city, fresh.timezone], ['seoul', 'Asia/Seoul']);
});

test('a sparse leaf whose only venue carries no day_int is skipped, and the run goes on', async () => {
  // The day_int check judged each box or leaf on its own, so one leaf whose
  // only venue left the day out aborted the whole run and wrote nothing.
  const order = harvester.planTiles(['philly'], 20, 20).filter((p) => p.city === 'philly').map((p) => p.tile);
  const fresh = fx('ven_sparse_fresh', 39.9300, -75.2100, 'CAFE', 'ChIJharvestSparseFrsh', 61, { name: 'Sparse Fresh Cafe' });
  const lonely = order.find((t) => !AXIS.some((v) => inBox(t, v)) && !inBox(t, fresh));
  assert.ok(lonely, 'the philly grid has a box with none of the other venues');
  const sparse = fx('ven_sparse_dayless', (lonely.s + lonely.n) / 2000, (lonely.w + lonely.e) / 2000, 'BAR',
    'ChIJharvestSparseNoDy', 71, { name: 'Sparse Dayless Bar' });
  const fixture = [...AXIS, fresh, sparse];
  const noDayInt = (v) => v.venueId === sparse.venueId;

  const { summary, out } = await runHarvest(['--city=philly', '--new-only', '--commit'], fakeBestTime(fixture, { noDayInt }));
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.strictEqual(summary.exitCode, 0);
  assert.strictEqual(summary.stats.unverifiable, 7, 'the day-less venue is counted once a day');
  assert.deepStrictEqual([summary.venuesInserted, summary.rowsWritten], [1, 168]);
  assert.doesNotMatch(out, /said which day they are for/);
  const { rows } = await pool.query(
    `SELECT v.besttime_venue_id AS id, COUNT(t.id)::int AS n FROM ml_venues v LEFT JOIN ml_training_data t ON t.venue_id = v.id
      WHERE v.besttime_venue_id LIKE 'ven_sparse_%' GROUP BY 1 ORDER BY 1`
  );
  assert.deepStrictEqual(rows, [{ id: 'ven_sparse_fresh', n: 168 }]);
});

test('a market-day on which no venue said its day still aborts, and writes nothing', async () => {
  const fresh = fx('ven_dayless_all', 39.9310, -75.2120, 'CAFE', 'ChIJharvestDaylessAll', 81, { name: 'Dayless All Cafe' });
  const before = await snapshot();
  const { summary, out } = await runHarvest(['--city=philly', '--new-only', '--commit'],
    fakeBestTime([...AXIS, fresh], { noDayInt: (v, day) => day === 2 }));
  assert.strictEqual(summary.aborted, true);
  assert.strictEqual(summary.exitCode, 1);
  assert.match(summary.abortReason, /none of the \d+ venues for Wed in philly said which day they are for; nothing is written/);
  assert.match(out, /ABORTED/);
  assert.deepStrictEqual(await snapshot(), before, 'an aborted run wrote');
});

test('--cache-dir keeps what an aborted run fetched, and a rerun answers from it without the network or the budget', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-harvest-cache-'));
  try {
    const fresh = fx('ven_cache_new', 39.9330, -75.2150, 'CAFE', 'ChIJharvestCacheNew01', 91, { name: 'Cache Corner Cafe' });
    const fixture = [...AXIS, fresh];
    const filterCalls = (fake) => fake.requests.filter((r) => r.path === '/api/v1/venues/filter');
    const cacheFiles = () => fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));

    // Every question this scope asks, without a cache.
    const plain = fakeBestTime(fixture);
    const reference = await runHarvest(['--city=philly', '--new-only'], plain);
    assert.strictEqual(reference.summary.exitCode, 0, reference.summary.abortReason);
    const total = filterCalls(plain).length;
    assert.strictEqual(fs.readdirSync(cacheDir).length, 0, 'a run without --cache-dir wrote a cache');

    // An aborted run (the key refused on Thursday) keeps every answer it had.
    const aborted = fakeBestTime(fixture, { failDay: 3, echoKey: true });
    const first = await runHarvest(['--city=philly', '--new-only', `--cache-dir=${cacheDir}`], aborted);
    assert.strictEqual(first.summary.aborted, true);
    const answered = filterCalls(aborted).filter((r) => r.params.day_int !== '3').length;
    assert.ok(answered > 0 && answered < total);
    assert.strictEqual(cacheFiles().length, answered, 'one cache file per answered request');
    for (const f of cacheFiles()) {
      const text = fs.readFileSync(path.join(cacheDir, f), 'utf8');
      assert.ok(!text.includes(FAKE_PRIVATE) && !text.includes(FAKE_PUBLIC), `${f} holds the key`);
      assert.ok(!/api_key_private=/.test(text), `${f} names the key parameter`);
      assert.match(JSON.parse(text).url, /^https:\/\/besttime\.app\/api\/v1\/venues\/filter\?/);
    }

    // The rerun asks the network only what the aborted run never answered.
    const second = fakeBestTime(fixture);
    const dry = await runHarvest(['--city=philly', '--new-only', `--cache-dir=${cacheDir}`], second);
    assert.strictEqual(dry.summary.exitCode, 0, dry.summary.abortReason);
    assert.strictEqual(filterCalls(second).length, total - answered);
    assert.strictEqual(dry.summary.stats.cachedPages, answered);
    assert.strictEqual(cacheFiles().length, total);

    // And a third, every answer cached, makes no filter request at all, is not
    // held to a budget of one page, and writes the week the answers give.
    const offline = fakeBestTime([]);
    const { summary, out } = await runHarvest(
      ['--city=philly', '--new-only', '--commit', `--cache-dir=${cacheDir}`, '--result-budget=100'], offline
    );
    assertNoKey(out);
    assert.strictEqual(summary.aborted, false, summary.abortReason);
    assert.strictEqual(summary.exitCode, 0);
    assert.deepStrictEqual(filterCalls(offline), [], 'a cached question went to the network');
    assert.ok(offline.requests.every((r) => r.path.startsWith('/api/v1/keys/')), 'only the free key-status reads remain');
    assert.deepStrictEqual([summary.stats.requests, summary.stats.venuesReturned, summary.stats.cachedPages, summary.budget.stopped],
      [0, 0, total, false]);
    assert.strictEqual(summary.stats.cachedResults, reference.summary.stats.venuesReturned);
    assert.deepStrictEqual(summary.plan, reference.summary.plan);
    assert.match(out, new RegExp(`answered ${total} filter pages from the cache \\(${summary.stats.cachedResults} results, not billed`));
    assert.deepStrictEqual([summary.venuesInserted, summary.rowsWritten], [1, 168]);
    const { rows: [row] } = await pool.query("SELECT id FROM ml_venues WHERE besttime_venue_id = 'ven_cache_new'");
    const { rows } = await pool.query('SELECT day_of_week, hour, busyness_pct FROM ml_training_data WHERE venue_id = $1', [row.id]);
    assert.strictEqual(rows.length, 168);
    for (const r of rows) {
      let want = null;
      for (let d = 0; d < 7 && want === null; d++) {
        for (let s = 0; s < 24; s++) {
          const local = bestTimeSlotToLocal(s, bestTimeDayToJsDay(d));
          if (local.dayOfWeek === r.day_of_week && local.hour === r.hour) { want = fresh.week[d][s]; break; }
        }
      }
      assert.strictEqual(r.busyness_pct, want, `day ${r.day_of_week} hour ${r.hour}`);
    }

    assert.match(harvester.parseArgs(['node', 'h.js', '--cache-dir=']).error, /--cache-dir/);
    assert.strictEqual(harvester.parseArgs(['node', 'h.js']).cacheDir, null);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// An independent review, 2026-11-18.
// ---------------------------------------------------------------------------

// The fake, with its first filter request handed to `fail(send)` instead:
// `send()` delivers it to the fake and gives back the answer, so a request can
// be lost after BestTime saw it, answered by a failure, or never sent at all.
function failFirstFilter(fake, fail) {
  const inner = fake.fetchImpl;
  let failed = false;
  fake.fetchImpl = async (input, init = {}) => {
    if (!failed && new URL(String(input)).pathname === '/api/v1/venues/filter') {
      failed = true;
      return fail(() => inner(input, init));
    }
    return inner(input, init);
  };
  return fake;
}

test('a request that may have been billed without an answer keeps a page reserved, and no retry passes the budget', async () => {
  const filterCalls = (fake) => fake.requests.filter((r) => r.path === '/api/v1/venues/filter').length;

  // --page-size=100 --result-budget=100: BestTime answered the first page and
  // its body was lost on the way back, so up to a hundred results may have
  // been billed. A retry could bill a hundred more, and is not made.
  const lost = failFirstFilter(fakeBestTime(AXIS), async (send) => {
    const res = await send();
    return { ...res, json: async () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); } };
  });
  const a = await runHarvest(['--city=philly', '--days=0', '--result-budget=100'], lost);
  assertNoKey(a.out);
  assert.strictEqual(a.summary.aborted, false, a.summary.abortReason);
  assert.strictEqual(filterCalls(lost), 1, 'the retry was sent although it could pass the budget');
  assert.deepStrictEqual(
    [a.summary.budget.stopped, a.summary.budget.used, a.summary.budget.reserved, a.summary.stats.venuesReturned],
    [true, 100, 100, 0]
  );
  assert.match(a.out, /network error \(AbortError\); 100 results reserved against the budget \(100 in all\)/);
  assert.match(a.out, /RESULT BUDGET: stopped in philly with 100 of 100 results used \(0 counted from answers, 100 reserved/);

  // A 5xx may have been served too. Its page stays reserved after the retry
  // succeeds, beside what the retry counted.
  const plain = fakeBestTime(AXIS);
  const reference = await runHarvest(['--city=philly', '--days=0'], plain);
  const counted = reference.summary.stats.venuesReturned;
  assert.ok(counted > 0);
  const busy = failFirstFilter(fakeBestTime(AXIS), async (send) => { await send(); return jsonResponse(502, {}); });
  const b = await runHarvest(['--city=philly', '--days=0'], busy);
  assert.strictEqual(b.summary.aborted, false, b.summary.abortReason);
  assert.strictEqual(filterCalls(busy), filterCalls(plain) + 1);
  assert.strictEqual(b.summary.stats.venuesReturned, counted);
  assert.deepStrictEqual([b.summary.budget.reserved, b.summary.budget.used], [100, counted + 100]);
  assert.match(b.out, /HTTP 502; 100 results reserved against the budget \(100 in all\); retry 1\//);
  assert.match(b.out, new RegExp(`Results: ${counted} counted from answers and 100 reserved for requests that may have been billed `
    + `without one, ${counted + 100} of the 60000 budget`));

  // A refused connection never reached BestTime: nothing is reserved.
  const refused = failFirstFilter(fakeBestTime(AXIS), async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  });
  const c = await runHarvest(['--city=philly', '--days=0'], refused);
  assert.strictEqual(c.summary.aborted, false, c.summary.abortReason);
  assert.strictEqual(c.summary.stats.requests, reference.summary.stats.requests + 1);
  assert.deepStrictEqual([c.summary.budget.reserved, c.summary.budget.used], [0, counted]);
  assert.match(c.out, /network error \(ECONNREFUSED\); never sent, nothing reserved; retry 1\//);

  // No route to BestTime at all is never sent either, so a run on a one-page
  // budget still gets its retry.
  for (const code of ['ENETUNREACH', 'EHOSTUNREACH']) {
    const unreachable = failFirstFilter(fakeBestTime(AXIS), async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code, syscall: 'connect' } });
    });
    const u = await runHarvest(['--city=philly', '--days=0'], unreachable);
    assert.strictEqual(u.summary.aborted, false, u.summary.abortReason);
    assert.deepStrictEqual([u.summary.budget.reserved, u.summary.budget.used], [0, counted]);
    assert.match(u.out, new RegExp(`network error \\(${code}\\); never sent, nothing reserved; retry 1/`));
  }

  // The same codes while an answer was being read may follow a billed
  // request: a page is reserved, and a one-page budget stops before a retry.
  const cutMidAnswer = failFirstFilter(fakeBestTime(AXIS), async () => {
    throw Object.assign(new TypeError('terminated'), { cause: { code: 'ENETDOWN', syscall: 'read' } });
  });
  const m = await runHarvest(['--city=philly', '--days=0', '--page-size=100', '--result-budget=100'], cutMidAnswer);
  assert.ok(m.summary.budget.reserved >= 100, `reserved ${m.summary.budget.reserved}`);
  assert.strictEqual(m.summary.stats.requests, 1);
});

test('a day mismatch seen before a budget stop still refuses the run, and nothing is written', async () => {
  // Monday's answer in the box after a finished one names Sunday for one
  // venue; the budget then stops Tuesday's request inside that box's leaf.
  // The stop skipped the mismatch check, and the finished box's new venue was
  // committed.
  const order = harvester.planTiles(['philly'], 20, 20).filter((p) => p.city === 'philly').map((p) => p.tile);
  const lastAxis = Math.max(...order.map((t, i) => (AXIS.some((v) => inBox(t, v)) ? i : -1)));
  const c0 = harvester.CENTROIDS.philly;
  const usable = order.slice(lastAxis + 1).filter((t) => t.n - t.s >= 40 && t.e - t.w >= 40);
  assert.ok(usable.length >= 2, 'the philly grid has two boxes after the axis venues');
  const nearCentre = (t) => ({
    lat: Math.min(Math.max(c0.lat, (t.s + 15) / 1000), (t.n - 15) / 1000),
    lng: Math.min(Math.max(c0.lon, (t.w + 15) / 1000), (t.e - 15) / 1000),
  });
  const [p0, p1] = [nearCentre(usable[0]), nearCentre(usable[1])];
  const fresh = fx('ven_mismatch_fresh', p0.lat, p0.lng, 'CAFE', 'ChIJharvestMismatchF01', 63, { name: 'Mismatch Fresh Cafe' });
  const wrong = fx('ven_mismatch_wrong', p1.lat, p1.lng, 'BAR', 'ChIJharvestMismatchW01', 73, { name: 'Mismatch Wrong Bar' });
  for (const v of [fresh, wrong]) assert.ok(nearestPaCity(v.lat, v.lng).km < 19, 'a venue sits past the radius');
  const fixture = [...AXIS, fresh, wrong];
  const wrongAt = order.indexOf(usable[1]);
  const before = 7 * order.slice(0, wrongAt).reduce((n, t) => n + fixture.filter((v) => inBox(t, v)).length, 0);
  // Monday in the wrong venue's box fits (before + 100); Tuesday, after its
  // one result, does not (before + 1 + 100).
  const budget = before + 100;
  const dayFor = (v, day) => (v.venueId === wrong.venueId && day === 0 ? 6 : day);

  const snap = await snapshot();
  const { summary, out } = await runHarvest(
    ['--city=philly', '--new-only', '--commit', `--result-budget=${budget}`], fakeBestTime(fixture, { dayFor })
  );
  assertNoKey(out);
  assert.match(out, new RegExp(`RESULT BUDGET: stopped in philly with ${before + 1} of ${budget} results used`),
    'the budget did not stop the run where this test needs it');
  assert.strictEqual(summary.aborted, true, 'a budget stop let an observed day mismatch through');
  assert.strictEqual(summary.exitCode, 1);
  assert.match(summary.abortReason, /BestTime answered 1 venues for a different day than the one asked \(1 when Mon was asked\)\. The day parameter is not being honoured; nothing from this run is written/);
  assert.strictEqual(summary.stats.otherDay, 1);
  assert.deepStrictEqual(await snapshot(), snap, 'the run wrote');
});
