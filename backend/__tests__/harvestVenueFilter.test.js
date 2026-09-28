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
//     id (curves filed, no id stamped), a new row only with a real place id,
//     outside-market venues skipped, and never a second identity for one place;
//   * a dry run writes nothing (xmin snapshot), a commit upserts, a rerun
//     changes nothing but collected_at;
//   * an empty run, an aborted run and a refused key all exit nonzero;
//   * paging stops at the cap and a capped box is split, down to a minimum.
//
// HOW TO RUN
//   cd backend && node --test __tests__/harvestVenueFilter.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

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

// A point inside a tile the harvester will ask about but more than MAX_KM from
// both centroids, derived from the tiling itself so the fixture cannot drift
// out of the area the harvester covers.
function outsidePoint() {
  for (const t of harvester.buildTiles(['philly', 'lehigh'], 20)) {
    for (const [lat, lng] of [[t.s + 0.5, t.w + 0.5], [t.s + 0.5, t.e - 0.5], [t.n - 0.5, t.w + 0.5], [t.n - 0.5, t.e - 0.5]]) {
      if (!nearestPaCity(lat / 1000, lng / 1000).cityKey) return { lat: lat / 1000, lng: lng / 1000 };
    }
  }
  throw new Error('fixture: no tile corner lies outside both markets');
}
const OUT = outsidePoint();

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
};
const FIXTURE = Object.values(V);

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function toRecord(v, day) {
  const rec = {
    venue_id: v.venueId, venue_name: `Venue ${v.venueId}`, venue_address: '1 Test St, Philadelphia, PA',
    venue_lat: v.lat, venue_lng: v.lng, venue_type: v.type, day_int: day, day_info: { day_int: day },
    day_raw_whole: v.week[day], rating: v.rating, reviews: v.reviews, price_level: 2,
  };
  // The published schema names no place-id field; the harvester reads the
  // likely spellings, and this fake uses one of them.
  if (v.placeId) rec.place_id = v.placeId;
  return rec;
}

// A fake BestTime. The filter answers by inclusive bounding box, day and
// page; `reportTotal` makes venues_n the box total rather than the page count
// (the documentation does not say which it is, and the harvester must be right
// under both). Every request is recorded.
function fakeBestTime(fixture, { reportTotal = false, failDay = null, failStatus = 402, ignoreDay = false } = {}) {
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
        venues: slice.map((v) => toRecord(v, ignoreDay ? 0 : day)),
        venues_n: reportTotal ? inBox.length : slice.length,
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

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-harvest-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'harvestVenueFilter', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_harvest_test');
  pool = new Pool({ connectionString: CONN });
  await migrate(pool);

  const insertVenue = async (tag, placeId, btId, category, extra = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                              venue_category, rating, review_count, timezone)
       VALUES ($1, $2, $3, 'philly', 39.95, -75.16, $4, $5, $6, 'America/New_York') RETURNING id`,
      [placeId, btId, `Seeded ${tag}`, category,
        'rating' in extra ? extra.rating : 4.2, 'reviews' in extra ? extra.reviews : 300]
    );
    seeded[tag] = rows[0].id;
  };
  await insertVenue('knownBt', 'ChIJharvestKnownBt01', 'ven_known_bt', 'bar');
  await insertVenue('knownPlace', 'ChIJharvestKnownPl01', null, 'restaurant');
  await insertVenue('otherBt', 'ChIJharvestHeldElse1', 'ven_someone_else', 'bar');
  // A row the old discovery path minted: pseudo place id, real BestTime id.
  await insertVenue('pseudoRow', 'bt_ven_pseudo_row', 'ven_pseudo_row', 'bar', { rating: null, reviews: null });

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
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`[harvestVenueFilter] could not remove ${dataDir}: ${err.message}`);
  }
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
  assert.deepStrictEqual(summary.plan, { known_bt: 2, known_place: 1, new: 3 });
  assert.strictEqual(summary.rowsPlanned, 6 * 168);
  assert.deepStrictEqual(summary.skipped, {
    outsideMarkets: 1, otherMarket: 0, noPlaceId: 1, unusablePlaceId: 1, placeHeldByOtherBtId: 1,
    placeClaimedTwice: 2, unmappedType: 1, noName: 0, noSignal: 1, noCoordinates: 0,
  });
  assert.match(out, /DRY RUN/);
  assert.match(out, /Would write 1008 weekly rows for 6 venues and add 3 ml_venues rows/);
  assert.match(out, /Account before: key OK/);
  assert.match(out, /Account after: key OK/);
  assert.match(out, /tiles of about 20 km/);
  assert.deepStrictEqual(await snapshot(), before, 'the dry run changed or rewrote a row');
});

test('--commit files every week under the right identity and mints none twice', async () => {
  const { summary, out } = await runHarvest(['--commit'], fakeBestTime(FIXTURE));
  assertNoKey(out);
  assert.strictEqual(summary.aborted, false, summary.abortReason);
  assert.strictEqual(summary.exitCode, 0);
  assert.strictEqual(summary.venuesInserted, 3);
  assert.strictEqual(summary.rowsWritten, 1008);
  assert.strictEqual(summary.rowsRefreshed, 1, 'the one stale row is refreshed, the rest are new');
  assert.strictEqual(summary.writeFailures, 0);

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

  // Never added.
  for (const id of ['ven_no_place', 'ven_pseudo', 'ven_outside', 'ven_other_bt', 'ven_supermarket', 'ven_zero', 'ven_twin_other']) {
    assert.ok(!held.has(id), `${id} was added`);
  }
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
  ];
  for (const [venueId, fixture] of written) {
    const expected = new Map();
    for (let d = 0; d < 7; d++) {
      for (let s = 0; s < 24; s++) {
        const local = bestTimeSlotToLocal(s, bestTimeDayToJsDay(d));
        expected.set(`${local.dayOfWeek}:${local.hour}`, fixture.week[d][s]);
      }
    }
    const { rows } = await pool.query(
      `SELECT day_of_week, hour, busyness_pct, collection_mode, hour_axis, label_source, besttime_epoch,
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
      assert.strictEqual(r.besttime_epoch, null, 'an analysis epoch the filter never reported');
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
  assert.strictEqual(stale.besttime_epoch, null);
  const { rows: [stamped] } = await pool.query('SELECT last_collected_at FROM ml_venues WHERE id = $1', [seeded.knownBt]);
  assert.ok(stamped.last_collected_at, 'last_collected_at not set after rows landed');
});

test('a rerun changes nothing but the refresh time', async () => {
  const before = await snapshot();
  const { summary } = await runHarvest(['--commit'], fakeBestTime(FIXTURE));
  assert.strictEqual(summary.exitCode, 0);
  assert.strictEqual(summary.venuesInserted, 0);
  assert.strictEqual(summary.rowsInserted, 0);
  assert.strictEqual(summary.rowsRefreshed, 1008);
  const after = await snapshot();

  const venueKey = (v) => [v.id, v.google_place_id, v.besttime_venue_id, v.city, v.is_active, v.besttime_status].join('|');
  assert.deepStrictEqual(after.venues.map(venueKey), before.venues.map(venueKey), 'ml_venues changed on a rerun');
  const rowKey = (r) => [r.id, r.venue_id, r.day_of_week, r.hour, r.busyness_pct].join('|');
  assert.deepStrictEqual(after.training.map(rowKey), before.training.map(rowKey), 'weekly rows changed on a rerun');
  const beforeAt = new Map(before.training.map((r) => [r.id, r.collected_at.getTime()]));
  const refreshed = after.training.filter((r) => r.collected_at.getTime() > beforeAt.get(r.id));
  assert.strictEqual(refreshed.length, after.training.length, 'a row the rerun re-read was not stamped as refreshed');
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
  for (const args of [['--city=nyc'], ['--days=7'], ['--page-size=600'], ['--frobnicate']]) {
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
