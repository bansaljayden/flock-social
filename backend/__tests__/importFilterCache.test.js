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
//     are not progress.json's notFound (a partial city, or one with no count),
//     whose replay stopped (a record for another day, a weekday that named
//     none, an answer with no venue list, each by its own name), with a
//     malformed record, a curve slot that is no number from 0 to 100, a short
//     page whose venues_n says more were there, a box still at the 500 cap at
//     the smallest tile, whose month is not one, whose progress record
//     disagrees with the plan, that the plan marks config:true or whose key is
//     a holdout, beijing or a training city (those folders are never opened),
//     or whose replay does not reproduce the cacher's own inventory (a
//     saturated box gone with every box below it passes every other rule);
//   * the import never holds a BestTime key: a key variable set before it
//     loads, or loaded by a module, refuses it before any answer is read, and
//     a clean run reads none and never loads a .env from its working folder
//     (in child processes);
//   * the twin rule and identity rule 4 reach every longitude cell 40 m spans,
//     at 70 degrees too, and one cell either side wherever that is enough;
//   * one global placement: a venue nearer a training city, a holdout, beijing
//     or a refused cache city is dropped, and so is one within 80 km of a
//     holdout or beijing wherever it is placed; one inside two cities' circles
//     is one venue, its record the city it is placed in's, its missing days
//     filled from the other; one inside a large circle but nearer a small
//     neighbour is kept, under the neighbour;
//   * with an identity snapshot, a venue ml_venues holds (by BestTime id,
//     place id or as a near-duplicate) is dropped, and so is one within 2 km
//     of any ml_venues row or of any venue the export holds; the 2 km search
//     reaches every grid cell 2 km spans, at any latitude; without the
//     snapshot both are "pending"; an export holding a venue the snapshot
//     lacks, or cache rows already, is refused; --write and --parity refuse a
//     snapshot without its meta, one row short of the table (an unlabelled
//     venue no export shows), changed after its hash was taken, or taken with
//     a WHERE, and a dry run says a snapshot without one is unproven;
//   * the rows: the export's 48-column HEADER, city world_cache, synthetic ids
//     from 1,000,000,000, no Google types or price, month 11 and fall, the
//     venue's own value as its baseline, rating as NUMERIC(2,1) stores it;
//     the sidecar and the manifest's SHA-256s, the export's among them;
//   * the peak-hour check flags a city whose bar or nightclub mode moves 3 h
//     or more from the training cities' (3 h flags, 2 h does not, in both
//     directions and for nightclubs too), and --write leaves it out unless
//     named; a comparison an empty, unreadable or partial reference cannot
//     make is reported unavailable, and --write refuses;
//   * END TO END: fixture answers written by the harvester's own --offline
//     --commit into a real migrated Postgres, exported by the real exporter,
//     and --parity finds every exported weekly row of the venues this folder
//     wrote equal to the generator's, leaving out live rows and the venues
//     another pass wrote (by the snapshot's created_at), never as mismatches;
//     a correct row held twice fails it, so does a venue whose every answer is
//     gone (the snapshot shows its write), and so does a verified report the
//     exporter joins into the feedback columns; damaged answers or another
//     miss count are refused; --write needs a whole feedback snapshot and
//     refuses a kept venue that has a verified report.
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

// Synchronous, before the requires below: the database every module sees.
// None of them loads backend/.env when required.
const PG_PORT = pickEmbeddedPgPort('importFilterCache');
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_import_cache_test`;
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';

const { migrate } = require('../db/migrate');
const H = require('../scripts/ml/harvestVenueFilter');
const I = require('../scripts/ml/train/importFilterCache');
const exporter = require('../scripts/ml/train/export_training_data');
const { bestTimeSlotToLocal } = require('../scripts/ml/collectWeekly');
const { bestTimeDayToJsDay, VENUE_TARGETS } = require('../scripts/ml/config');
const { kmBetween } = require('../scripts/ml/addDemandVenues');

// The import refuses to run while any BESTTIME_API_KEY* variable is set (NO
// KEY in its header), and none of the modules above brings one in: only the
// shell running these tests could have.
const KEY_NAME_RE = /^BESTTIME_API_KEY/i;
for (const name of Object.keys(process.env)) if (KEY_NAME_RE.test(name)) delete process.env[name];

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
// question 404, which the harvest (and the cacher) never cache; `omit` leaves
// a venue out of one day's answers; `mutate` rewrites a record; `asked`
// collects every filter URL in the order it was asked.
function fakeFilter(venues, { notFoundWhen = () => false, omit = () => false, mutate = null, asked = null } = {}) {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/v1/venues/filter') return jsonResponse(404, {});
    if (asked) asked.push(String(input));
    const p = url.searchParams;
    const day = Number(p.get('day_int'));
    const box = { s: Number(p.get('lat_min')), n: Number(p.get('lat_max')), w: Number(p.get('lng_min')), e: Number(p.get('lng_max')) };
    const page = Number(p.get('page'));
    const limit = Number(p.get('limit'));
    const inBox = venues.filter((v) => v.lat >= box.s && v.lat <= box.n && v.lng >= box.w && v.lng <= box.e && !omit({ day, v }));
    if (notFoundWhen({ day, box, page, inBox })) return jsonResponse(404, {});
    const slice = inBox.slice(page * limit, page * limit + limit);
    const recs = slice.map((v) => (mutate ? mutate({ day, page, v }, record(v, day)) : record(v, day)));
    return jsonResponse(200, { status: 'OK', venues: recs, venues_n: recs.length });
  };
}

const answerFile = (url) => H.cacheFileName(H.cacheKeyUrl(url));

// Fills `dir` the way the cacher did: the harvester's own questions, asked
// online against the fake with --cache-dir, every answer kept. Returns the
// 404 count, which is what progress.json records as notFound, the files of
// the first and last questions asked, and the inventory the cacher would have
// recorded for the run (its requests, cachedPages, results, distinct venue
// ids, tiles, splits, leaves, boxes cut, records for another day), counted
// as the fill went, before any test damages a file.
async function fillCache(dir, {
  cities, radiusKm, centroids = null, venues, notFoundWhen, omit, mutate, fetchedAt = FETCHED_AT,
}) {
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
  const asked = [];
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFilter(venues, { notFoundWhen, omit, mutate, asked });
  try {
    for (const { area, tile } of tilePlan) {
      ctx.area = area;
      await H.harvestBox(ctx, tile, new Map());
    }
  } finally {
    globalThis.fetch = saved;
  }
  const ids = new Set();
  let otherDay = 0;
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    const day = Number(new URL(entry.url).searchParams.get('day_int'));
    for (const v of entry.data.venues || []) {
      if (v && v.venue_id) ids.add(String(v.venue_id));
      if (v && Number.isInteger(v.day_int) && v.day_int !== day) otherDay++;
    }
    entry.fetchedAt = fetchedAt;
    fs.writeFileSync(file, JSON.stringify(entry));
  }
  const s = ctx.stats;
  return {
    notFound: s.notFound, files: fs.readdirSync(dir).length,
    firstFile: path.join(dir, answerFile(asked[0])), lastFile: path.join(dir, answerFile(asked[asked.length - 1])),
    inventory: {
      requests: s.requests, cachedPages: s.cachedPages, results: s.venuesReturned, distinctVenues: ids.size,
      tiles: tilePlan.length, splits: s.splits, leaves: ctx.city.leaves, truncated: s.truncatedTiles, otherDay, oddAnswers: 0,
    },
  };
}

const progressRecord = (c, notFound, state = 'done') => ({
  name: c.key, lat: c.lat, lon: c.lon, radiusKm: c.radiusKm, config: false, note: '', dir: `${c.key}-2026-11-r${c.radiusKm}`,
  state, notFound, refusedQuestions: 0, oddAnswers: 0, otherDay: 0, truncated: 0,
});
// The cacher's run totals: no request retried.
const RUN_TOTALS = { requests: 0, throttled: 0, networkErrors: 0 };

const rewriteAnswer = (file, change) => {
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(entry);
  fs.writeFileSync(file, JSON.stringify(entry));
};

// A snapshot's meta as plan step C.4 writes it, from the CSV as it stands:
// every count agrees with the file unless `overrides` says the table held
// something else.
function writeSnapshotMeta(file, overrides = {}) {
  const bytes = fs.readFileSync(file);
  const ids = I.parseCsv(bytes.toString('utf8')).slice(1).filter((r) => r.length > 1).map((r) => Number(r[0]));
  const meta = {
    table: 'ml_venues', query: I.SNAPSHOT_QUERY, isolation: 'REPEATABLE READ READ ONLY, one transaction',
    snapshotAt: '2026-11-25T19:31:05.168Z', tableCount: ids.length, tableMinId: ids[0], tableMaxId: ids[ids.length - 1],
    rowsWritten: ids.length, firstId: ids[0], lastId: ids[ids.length - 1],
    csvSha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...overrides,
  };
  fs.writeFileSync(I.snapshotMetaFile(file), JSON.stringify(meta, null, 2));
  return meta;
}

// A feedback snapshot of verified reports by place id ([placeId, n] pairs),
// and its meta as the read-only transaction writes it.
function writeFeedbackSnapshot(file, pairs, overrides = {}) {
  fs.writeFileSync(file, `${['venue_place_id,verified_reports', ...pairs.map(([p, n]) => `${p},${n}`)].join('\n')}\n`);
  const bytes = fs.readFileSync(file);
  const reports = pairs.reduce((a, [, n]) => a + n, 0);
  const meta = {
    table: 'venue_feedback',
    query: 'SELECT venue_place_id, COUNT(*)::int AS verified_reports FROM venue_feedback WHERE verified = true AND '
      + 'venue_place_id IS NOT NULL GROUP BY venue_place_id ORDER BY venue_place_id',
    countQuery: 'SELECT COUNT(*) FROM venue_feedback WHERE verified = true',
    isolation: 'REPEATABLE READ READ ONLY, one transaction', snapshotAt: '2026-11-25T22:01:00.000Z',
    tableVerifiedCount: reports, tableAllRows: reports + 4, rowsWritten: pairs.length, verifiedReportsWritten: reports,
    csvSha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...overrides,
  };
  fs.writeFileSync(I.snapshotMetaFile(file), JSON.stringify(meta, null, 2));
  return file;
}

// A cache root of one city, filled by the harvester's own questions, with
// its plan and the progress record the cacher would have kept.
async function singleCityRoot(c, venues, { notFoundWhen } = {}) {
  const dir = tmp('flock-import-one-');
  const filled = await fillCache(path.join(dir, `${c.key}-2026-11-r${c.radiusKm}`), {
    cities: [c.key], radiusKm: c.radiusKm, centroids: { [c.key]: { lat: c.lat, lon: c.lon } }, venues, notFoundWhen,
  });
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({
    totals: RUN_TOTALS, cities: { [c.key]: { ...progressRecord(c, filled.notFound), ...filled.inventory } },
  }));
  const planPath = path.join(dir, 'cities.json');
  fs.writeFileSync(planPath, JSON.stringify([{ key: c.key, name: c.key, lat: c.lat, lon: c.lon, radiusKm: c.radiusKm }]));
  return { root: dir, plan: planPath, dir: path.join(dir, `${c.key}-2026-11-r${c.radiusKm}`), ...filled };
}

// ---------------------------------------------------------------------------
// The fixture cache: a plan, its progress, its folders, a training reference.
// ---------------------------------------------------------------------------
const C = {
  testville: { key: 'testville', lat: 10.0, lon: 10.0, radiusKm: 10 },
  twintown: { key: 'twintown', lat: 10.0, lon: 10.16, radiusKm: 10 },
  nearphilly: { key: 'nearphilly', lat: 40.05, lon: -75.0, radiusKm: 10 },
  nearmiami: { key: 'nearmiami', lat: 25.86, lon: -80.36, radiusKm: 12 },
  nearbeijing: { key: 'nearbeijing', lat: 40.05, lon: 116.55, radiusKm: 10 },
  peaktown: { key: 'peaktown', lat: -24.0, lon: -30.0, radiusKm: 10 },
  // 44 km apart; bigcity's circle reaches past the point nearer smallcity.
  bigcity: { key: 'bigcity', lat: -30.0, lon: -20.0, radiusKm: 30 },
  smallcity: { key: 'smallcity', lat: -30.0, lon: -19.5436, radiusKm: 5 },
  partialtown: { key: 'partialtown', lat: 12.0, lon: 12.0, radiusKm: 10 },
  missytown: { key: 'missytown', lat: 14.0, lon: 14.0, radiusKm: 10 },
  extratown: { key: 'extratown', lat: 16.0, lon: 16.0, radiusKm: 10 },
  nocounttown: { key: 'nocounttown', lat: -22.0, lon: -30.0, radiusKm: 5 },
  wrongdaytown: { key: 'wrongdaytown', lat: -10.0, lon: -30.0, radiusKm: 5 },
  nodaytown: { key: 'nodaytown', lat: -12.0, lon: -30.0, radiusKm: 5 },
  brokentown: { key: 'brokentown', lat: -14.0, lon: -30.0, radiusKm: 5 },
  malformtown: { key: 'malformtown', lat: -16.0, lon: -30.0, radiusKm: 5 },
  movedtown: { key: 'movedtown', lat: -18.0, lon: -30.0, radiusKm: 5 },
  decembertown: { key: 'decembertown', lat: -20.0, lon: -30.0, radiusKm: 5 },
  stringtown: { key: 'stringtown', lat: -26.0, lon: -30.0, radiusKm: 5 },
  shorttown: { key: 'shorttown', lat: -28.0, lon: -30.0, radiusKm: 5 },
  duptown: { key: 'duptown', lat: -34.0, lon: -30.0, radiusKm: 5 },
  // Refused (the cacher stopped it, no folder), 18.9 km north of testville.
  haltedtown: { key: 'haltedtown', lat: 10.17, lon: 10.0, radiusKm: 10 },
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
  // Inside both testville's and twintown's boxes, nearer testville. Testville's
  // answers leave it out on Thursday (day 3); twintown's hold every day.
  shared: vn('ven_t_k_shared', 10.0, 10.075, 'RESTAURANT', 'ChIJtestvilleSharedK01', weekFor(51)),
  // 11 m from snapshot row 105, "The Brass Lantern": identity rule 4.
  nearDup: vn('ven_t_l_neardup', 10.03, 10.03, 'RESTAURANT', 'ChIJtestvilleNearDupL1', weekFor(87), { name: 'Brass Lantern' }),
  // In testville's box, 9.8 km from it and 9.1 km from haltedtown.
  edge: vn('ven_t_m_edge', 10.088, 10.0, 'RESTAURANT', 'ChIJtestvilleEdgeM0001', weekFor(93)),
};
const W = {
  // Two hours off the training bars (22h) and nightclubs (23h): no flag.
  bar: vn('ven_w_a_bar', 10.0, 10.2, 'BAR', 'ChIJtwintownBarA00001', peakWeek(0)),
  // In both boxes, nearer twintown; testville's answers say 100 reviews,
  // twintown's (the city it is placed in) 200.
  both: vn('ven_w_b_both', 10.0, 10.09, 'RESTAURANT', 'ChIJtwintownBothB0001', weekFor(5), { reviews: 200 }),
  club: vn('ven_w_c_club', 10.01, 10.2, 'CLUBS', 'ChIJtwintownClubC0001', peakWeek(1)),
  // 1.1 km from the export's row for venue 104 (not from the snapshot's).
  exportNear: vn('ven_w_d_exportnear', 10.02, 10.2, 'RESTAURANT', 'ChIJtwintownExportD001', weekFor(11)),
};
const NP = { venue: vn('ven_np_a', 40.05, -75.0, 'BAR', 'ChIJnearphillyA000001', weekFor(57)) };
const NM = {
  holdout: vn('ven_nm_a_holdout', 25.80, -80.25, 'BAR', 'ChIJnearmiamiHoldout01', weekFor(63)),
  // Placed in nearmiami, 21 km from Miami's centroid.
  club: vn('ven_nm_b_club', 25.87, -80.37, 'CLUBS', 'ChIJnearmiamiClubB0001', peakWeek(1)),
};
const NB = {
  beijing: vn('ven_nb_a_beijing', 39.97, 116.47, 'BAR', 'ChIJnearbeijingA00001', weekFor(61)),
  near: vn('ven_nb_b_near', 40.10, 116.60, 'BAR', 'ChIJnearbeijingB00001', weekFor(67)),
};
const P = {
  // Three hours off, each way: both flag.
  bar: vn('ven_p_a_bar', -24.0, -30.0, 'BAR', 'ChIJpeaktownBarA00001', peakWeek(19)),
  club: vn('ven_p_b_club', -24.01, -30.0, 'CLUBS', 'ChIJpeaktownClubB0001', peakWeek(2)),
};
const BC = {
  home: vn('ven_bc_a_home', -30.0, -20.0, 'RESTAURANT', 'ChIJbigcityHomeA00001', weekFor(13)),
  // 27 km from bigcity (inside its 30 km), 17 km from smallcity (outside its 5).
  edge: vn('ven_bc_b_edge', -30.0, -19.7199, 'RESTAURANT', 'ChIJbigcityEdgeB00001', weekFor(17)),
  // In bigcity's box, inside neither circle.
  beyond: vn('ven_bc_c_beyond', -29.75, -19.75, 'RESTAURANT', 'ChIJbigcityBeyondC001', weekFor(19)),
};
const SC = { home: vn('ven_sc_a_home', -30.0, -19.5436, 'RESTAURANT', 'ChIJsmallcityHomeA0001', weekFor(23)) };
const PT = { venue: vn('ven_pt_a', 12.0, 12.0, 'BAR', 'ChIJpartialtownA00001', weekFor(69)) };
const MT = { venue: vn('ven_mt_a', 14.0, 14.0, 'BAR', 'ChIJmissytownA0000001', weekFor(75)) };
const XT = { venue: vn('ven_xt_a', 16.0, 16.0, 'BAR', 'ChIJextratownA0000001', weekFor(81)) };
const one = (key, seed) => vn(`ven_${key}_a`, C[key].lat, C[key].lon, 'BAR', `ChIJ${key}A`.padEnd(21, '0'), weekFor(seed));

let root;
let planFile;
let refDir;
let snapshotFile;
let shortFile;
let dupFile;
let feedbackFile;
let exportDir;
let absentExportDir;
let cacheExportDir;
const plan = [
  { key: 'miami', config: true, radiusKm: 40, note: 'HOLDOUT city' },
  ...Object.values(C).map((c) => ({ key: c.key, name: c.key, lat: c.lat, lon: c.lon, radiusKm: c.radiusKm })),
  { key: 'lehigh', name: 'Lehigh, a training city, not marked config', lat: 18.5, lon: 18.5, radiusKm: 10 },
  { key: 'tokyo', name: 'Tokyo, not marked config', lat: 35.6762, lon: 139.6503, radiusKm: 20 },
  { key: 'unreachedville', name: 'never cached', lat: 18.0, lon: 18.0, radiusKm: 10 },
];

// An export file: the HEADER, then one weekly row per [id, lat, lng, city].
function writeExportDir(train, holdout) {
  const dir = tmp('flock-import-export-fixture-');
  const line = ([id, lat, lng, city]) => exporter.rowToCsv(I.weeklyRow(
    { venue: { lat, lng, rating: 4.2, reviews: 30 }, category: 'bar', month: 11 },
    { dayOfWeek: 1, hour: 20, busyness: 50 }, { venueId: id, city }
  ));
  fs.writeFileSync(path.join(dir, 'training_data.csv'), `${[exporter.HEADER, ...train.map(line)].join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'holdout_data.csv'), `${[exporter.HEADER, ...holdout.map(line)].join('\n')}\n`);
  return dir;
}

async function buildFixture() {
  root = tmp('flock-import-cache-');
  const progress = { totals: RUN_TOTALS, cities: {} };
  const fill = async (c, venues, opts = {}) => {
    const dir = path.join(root, `${c.key}-2026-11-r${c.radiusKm}`);
    const centroids = { [c.key]: { lat: c.lat, lon: c.lon } };
    const r = await fillCache(dir, {
      cities: [c.key], radiusKm: c.radiusKm, centroids, venues,
      notFoundWhen: opts.notFoundWhen, omit: opts.omit, mutate: opts.mutate, fetchedAt: opts.fetchedAt,
    });
    progress.cities[c.key] = {
      ...progressRecord(c, opts.recordNotFound ?? r.notFound, opts.state), ...r.inventory, ...(opts.progress || {}),
    };
    return { dir, ...r };
  };
  // testville 404s one empty question, so its misses are real and recorded.
  const emptyDay3 = ({ day, inBox, page }) => day === 3 && page === 0 && inBox.length === 0;
  const tv = await fill(C.testville, [...Object.values(T), { ...W.both, reviews: 100 }], {
    notFoundWhen: emptyDay3, omit: ({ day, v }) => day === 3 && v.id === T.shared.id,
  });
  assert.ok(tv.notFound >= 0);
  await fill(C.twintown, [...Object.values(W), T.shared]);
  await fill(C.nearphilly, [NP.venue]);
  await fill(C.nearmiami, [NM.holdout, NM.club]);
  await fill(C.nearbeijing, [NB.beijing, NB.near]);
  await fill(C.peaktown, [P.bar, P.club]);
  await fill(C.bigcity, [...Object.values(BC), SC.home]);
  await fill(C.smallcity, [...Object.values(BC), SC.home]);
  // partialtown: stopped by the cacher, and one question it never answered.
  await fill(C.partialtown, [PT.venue], { state: 'stopped', recordNotFound: 0, notFoundWhen: ({ day, page }) => day === 5 && page === 0 });
  // missytown: an answer listing its venue lost after the fact, so misses
  // exceed notFound and the records listed fall short of the cacher's count.
  const mt = await fill(C.missytown, [MT.venue]);
  fs.unlinkSync(path.join(mt.dir, fs.readdirSync(mt.dir)
    .find((f) => JSON.parse(fs.readFileSync(path.join(mt.dir, f), 'utf8')).data.venues.length === 1)));
  // extratown: one answer no question of the replay asks.
  const xt = await fill(C.extratown, [XT.venue]);
  const stray = 'https://besttime.app/api/v1/venues/filter?lat_min=1.000&page=99';
  fs.writeFileSync(path.join(xt.dir, H.cacheFileName(stray)), JSON.stringify({ url: stray, fetchedAt: FETCHED_AT, data: { venues: [] } }));
  // nocounttown: progress.json kept no notFound.
  await fill(C.nocounttown, [one('nocounttown', 71)], { progress: { notFound: undefined } });
  // wrongdaytown: the LAST question's answer also lists a venue for another
  // day, so the day check is all that stands between it and acceptance.
  const wd = await fill(C.wrongdaytown, [one('wrongdaytown', 73)]);
  rewriteAnswer(wd.lastFile, (entry) => {
    const asked = Number(new URL(entry.url).searchParams.get('day_int'));
    entry.data.venues.push(record(vn('ven_wd_z_otherday', -10.0, -30.0, 'BAR', 'ChIJwrongdaytownZ0001', weekFor(1)), (asked + 1) % 7));
  });
  // nodaytown: on Friday (day 4) no record says which day it is for.
  await fill(C.nodaytown, [one('nodaytown', 77)], {
    mutate: ({ day }, rec) => { if (day === 4) { delete rec.day_int; delete rec.day_info; } return rec; },
  });
  // brokentown: the first answer has no venue list.
  const bk = await fill(C.brokentown, [one('brokentown', 79)]);
  rewriteAnswer(bk.firstFile, (entry) => { entry.data = { status: 'error', message: 'Internal failure' }; });
  // malformtown: Wednesday's record has no curve.
  await fill(C.malformtown, [one('malformtown', 83)], {
    mutate: ({ day }, rec) => { if (day === 2) delete rec.day_raw_whole; return rec; },
  });
  // movedtown: cached around another centroid than the plan's.
  await fill(C.movedtown, [one('movedtown', 85)], { progress: { lat: -18.5 } });
  // decembertown: fetched on 30 November, already December east of UTC+12.
  await fill(C.decembertown, [one('decembertown', 89)], { fetchedAt: '2026-11-30T12:00:00.000Z' });
  // stringtown: Tuesday's curve holds "35" in slot 7, a string readHours
  // would make a hole: 167 rows and nothing counted malformed.
  await fill(C.stringtown, [one('stringtown', 91)], {
    mutate: ({ day }, rec) => {
      if (day === 1) { rec.day_raw_whole = rec.day_raw_whole.slice(); rec.day_raw_whole[7] = '35'; }
      return rec;
    },
  });
  // shorttown: an answer listing its one venue says venues_n 2, and it is a
  // short page, so paging stopped there.
  const st = await fill(C.shorttown, [one('shorttown', 95)]);
  const listing = fs.readdirSync(st.dir).find((f) => JSON.parse(fs.readFileSync(path.join(st.dir, f), 'utf8')).data.venues.length === 1);
  rewriteAnswer(path.join(st.dir, listing), (entry) => { entry.data.venues_n = 2; });
  shortFile = listing;
  // duptown: an answer lists its venue twice, the second time with a 23-slot
  // curve. harvestDay keeps the first, so mergeDay never sees the second.
  const dt = await fill(C.duptown, [one('duptown', 97)]);
  const twice = fs.readdirSync(dt.dir).find((f) => JSON.parse(fs.readFileSync(path.join(dt.dir, f), 'utf8')).data.venues.length === 1);
  rewriteAnswer(path.join(dt.dir, twice), (entry) => {
    entry.data.venues.push({ ...entry.data.venues[0], day_raw_whole: entry.data.venues[0].day_raw_whole.slice(0, 23) });
  });
  dupFile = twice;
  // haltedtown: the cacher stopped it before it made a folder.
  progress.cities.haltedtown = progressRecord(C.haltedtown, 0, 'stopped');
  // A training city's key on a plan entry the plan forgot to mark config,
  // and the holdout's folder: each holds something no reader could parse, so
  // opening it at all would show.
  for (const [key, dir] of [['lehigh', 'lehigh-2026-11-r10'], ['miami', 'miami-2026-11-r40']]) {
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, `${'0'.repeat(64)}.json`), 'not json');
    progress.cities[key] = progressRecord({ key, lat: 18.5, lon: 18.5, radiusKm: Number(dir.slice(-2)) }, 0);
  }
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

  // The identity snapshot (plan step C.4's columns) and its meta.
  snapshotFile = path.join(root, 'ml_venues_snapshot.csv');
  const at = '2026-10-01T00:00:00.000000Z';
  fs.writeFileSync(snapshotFile, [
    'id,besttime_venue_id,google_place_id,name,latitude,longitude,city,besttime_status,created_at',
    `101,ven_t_h_knownbt,ChIJsnapshotKnownBt001,Known Bt Row,9.96,10.0,philly,,${at}`,
    `102,,ChIJtestvilleKnownPlI1,"Joe's ""Place"", Inc",10.0,9.96,philly,found,${at}`,
    // 1.5 km north of ven_t_j_near, nobody's identity.
    `103,ven_unrelated,ChIJsnapshotUnrelated1,Unrelated Row,9.9735,10.04,philly,harvested,${at}`,
    // 2.5 km north of ven_t_d_cafe: outside the 2 km rule.
    `104,ven_far_row,ChIJsnapshotFarRow0001,Far Row,10.0625,10.0,philly,,${at}`,
    `105,,ChIJsnapshotNearDup01,The Brass Lantern,10.0301,10.03,philly,,${at}`,
    // A corpus venue with no labelled rows: in neither export file.
    `106,,ChIJsnapshotUnlabelled1,Unlabelled Row,50.0,50.0,philly,found,${at}`,
    '',
  ].join('\n'));
  writeSnapshotMeta(snapshotFile);
  // Two verified reports, for a place no kept venue is.
  feedbackFile = writeFeedbackSnapshot(path.join(root, 'venue_feedback_verified.csv'), [['ChIJsomewhereElse000001', 2]]);
  // The export the rows join: 104 sits 1.1 km from ven_w_d_exportnear there,
  // wherever the snapshot puts it.
  exportDir = writeExportDir([[101, 9.96, 10.0, 'philly'], [104, 10.03, 10.2, 'philly'], [103, 9.9735, 10.04, 'philly']],
    [[102, 10.0, 9.96, 'miami']]);
  absentExportDir = writeExportDir([[101, 9.96, 10.0, 'philly'], [999, 50.0, 50.0, 'philly']], []);
  cacheExportDir = writeExportDir([[101, 9.96, 10.0, 'philly'], [1000000000, 50.0, 50.0, 'world_cache']], []);
}

async function runImport(args) {
  const lines = [];
  const result = await I.run(['node', 'importFilterCache.js', ...args], { log: (m) => lines.push(String(m)) });
  return { result, out: lines.join('\n') };
}

const baseArgs = () => [`--cache-root=${root}`, `--plan=${planFile}`];
const keptOf = (result, id) => result.kept.filter((k) => k.venue.venueId === id);
const reasons = (c) => c.reasons.map((r) => r.reason).sort();

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
    // The compact week holds exactly the cells, in the export's order.
    const { week, rows } = I.weekOf(new Map(days));
    const sorted = [...cells].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour);
    assert.equal(rows, cells.length);
    assert.deepEqual(I.cellsOfWeek(week), sorted, `trial ${k}`);
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

test('a CSV field may hold commas, doubled quotes and line breaks; created_at reads as ISO or as Postgres prints it', () => {
  assert.deepEqual(I.parseCsv('a,b,c\n1,"x, ""y""\nz",\r\n'), [['a', 'b', 'c'], ['1', 'x, "y"\nz', '']]);
  assert.throws(() => I.parseCsv('a,"b\n'), /never closes/);
  const at = Date.parse('2026-11-18T23:45:12.123Z');
  for (const s of ['2026-11-18T23:45:12.123456Z', '2026-11-18 23:45:12.123456+00', '2026-11-18 18:45:12.123-05:00',
    '2026-11-18 18:45:12.123-0500']) {
    assert.equal(I.parseTimestamp(s), at, s);
  }
  assert.ok(Number.isNaN(I.parseTimestamp('Tue Nov 18 2026')));
});

test('the 2 km rule reaches every cell 2 km can on kmBetween\'s sphere, at any latitude and across the antimeridian', () => {
  // The review's case: at 63.3 degrees, 1.998 km apart and three 0.02 degree
  // cells apart (500 and 503); the 111.32 km degree reached two.
  const hit633 = I.keepAwayIndex([{ id: 9, latitude: 63.3, longitude: 10.0600001 }])(63.3, 10.0199999);
  assert.ok(hit633 && hit633.row.id === 9 && hit633.km < 2, JSON.stringify(hit633));
  // Due east and due west of a point just inside a cell edge, 1.999 km away
  // (found) and 2.001 km away (not), at five latitudes.
  const along = (lat, km) => (2 * Math.asin(Math.sin(km / (2 * H.EARTH_KM)) / Math.cos((lat * Math.PI) / 180)) * 180) / Math.PI;
  for (const lat of [0, 45, 63.3, 70, -63.3]) {
    for (const [from, sign] of [[10.0000001, 1], [10.0199999, -1]]) {
      const near = { id: 1, latitude: lat, longitude: from + sign * along(lat, 1.999) };
      const far = { id: 2, latitude: lat, longitude: from + sign * along(lat, 2.001) };
      const km = kmBetween(lat, from, lat, near.longitude);
      assert.ok(km > 1.998 && km < 2, `${lat} ${sign}: ${km}`);
      const found = I.keepAwayIndex([near])(lat, from);
      assert.ok(found && found.row.id === 1, `${lat} ${sign}: ${JSON.stringify(found)}`);
      assert.equal(I.keepAwayIndex([far])(lat, from), null, `${lat} ${sign}: 2.001 km is outside`);
    }
  }
  // Across the antimeridian: 1.1 km apart at 10 degrees, found either way;
  // 2.2 km apart, not.
  const dateline = I.keepAwayIndex([{ id: 3, latitude: 10.0, longitude: 179.995 }]);
  assert.ok(dateline(10.0, -179.995) && dateline(10.0, -179.995).km < 1.2);
  assert.ok(I.keepAwayIndex([{ id: 4, latitude: 10.0, longitude: -179.995 }])(10.0, 179.995));
  assert.equal(I.keepAwayIndex([{ id: 5, latitude: 10.0, longitude: 179.99 }])(10.0, -179.99), null);
});

test('the 2 km rule searches every grid cell 2 km reaches, east and west, at any latitude', () => {
  // At 10 degrees a 0.02 degree cell is 2.2 km wide: a row 1.5 km due east
  // across a cell edge is one cell over, and so is one due west.
  const east = I.keepAwayIndex([{ id: 1, latitude: 10.0, longitude: 10.033 }])(10.0, 10.0195);
  assert.ok(east && east.row.id === 1 && east.km > 1.4 && east.km < 1.6, JSON.stringify(east));
  const west = I.keepAwayIndex([{ id: 2, latitude: 10.0, longitude: 10.006 }])(10.0, 10.0201);
  assert.ok(west && west.row.id === 2 && west.km > 1.4 && west.km < 1.6, JSON.stringify(west));
  // At 60 degrees it is 1.1 km wide: 1.5 km east is two cells over.
  const north = I.keepAwayIndex([{ id: 3, latitude: 60.0, longitude: 10.0469 }])(60.0, 10.0199);
  assert.ok(north && north.row.id === 3 && north.km > 1.4 && north.km < 1.6, JSON.stringify(north));
  assert.equal(I.keepAwayIndex([{ id: 4, latitude: 60.0, longitude: 10.065 }])(60.0, 10.0199), null, '2.5 km is outside');
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
  const write = ['--write', '--cache-root=a', '--plan=b', '--out-dir=o'];
  assert.match(p().error, /exactly one/);
  assert.match(p('--dry-run', '--write', '--cache-root=a', '--plan=b').error, /exactly one/);
  assert.match(p('--dry-run').error, /--cache-root and --plan/);
  assert.match(p(...write, '--harvest-cache=h', '--export-dir=e').error, /--identity-snapshot/);
  assert.match(p(...write, '--identity-snapshot=s', '--harvest-cache=h').error, /--export-dir/);
  assert.match(p(...write, '--identity-snapshot=s', '--export-dir=e').error, /--harvest-cache/);
  assert.match(p(...write, '--identity-snapshot=s', '--export-dir=e', '--harvest-cache=h').error, /--feedback-snapshot/);
  assert.match(p(...write, '--identity-snapshot=s', '--export-dir=e', '--harvest-cache=h', '--feedback-snapshot=f', '--only=x').error,
    /--only/);
  assert.equal(p(...write, '--identity-snapshot=s', '--export-dir=e', '--harvest-cache=h', '--feedback-snapshot=f').error, undefined);
  assert.match(p('--dry-run', '--cache-root=a', '--plan=b', '--export-dir=e').error, /checked against --identity-snapshot/);
  assert.match(p('--dry-run', '--cache-root=a', '--plan=b', '--accept-peak-flags=x').error, /--write/);
  assert.match(p('--parity', '--cache-dir=a', '--identity-snapshot=s', '--export-csv=e', '--cities=miami', '--radius-km=20').error, /training-city/);
  assert.match(p('--parity', '--cache-dir=a', '--identity-snapshot=s', '--export-csv=e', '--cities=philly').error, /--radius-km/);
  assert.match(p('--parity', '--cache-dir=a', '--identity-snapshot=s', '--export-csv=e', '--cities=philly', '--radius-km=20',
    '--export-dir=d').error, /not --parity/);
  assert.match(p('--dry-run', '--cache-root=a', '--plan=b', '--bogus').error, /Unknown/);
  assert.equal(p('--dry-run', '--cache-root=a', '--plan=b').progress, path.join(path.resolve('a'), 'progress.json'));
  // A harvest-cache run folder names its run; --parity reads it, and refuses
  // a scope that disagrees with it.
  assert.deepEqual(I.runFolderScope('denver,seattle,chicago,la-2026-11'), { cities: ['denver', 'seattle', 'chicago', 'la'], radiusKm: 20 });
  assert.deepEqual(I.runFolderScope('philly+lehigh-2026-11-r40'), { cities: ['philly', 'lehigh'], radiusKm: 40 });
  assert.equal(I.runFolderScope('notes'), null);
  const bounded = ['--expect-misses=0', '--written-before=2026-11-20T00:00:00Z'];
  const inferred = p('--parity', '--cache-dir=x/nyc-2026-11-r40', '--identity-snapshot=s', '--export-csv=e', ...bounded);
  assert.deepEqual([inferred.cities, inferred.radiusKm], [['nyc'], 40]);
  assert.match(p('--parity', '--cache-dir=x/nyc-2026-11-r40', '--identity-snapshot=s', '--export-csv=e', '--radius-km=20').error,
    /would ask other questions/);
  // --expect-misses and --written-before (an instant with its zone) are
  // required by --parity and belong to nothing else.
  const parityArgs = ['--parity', '--cache-dir=x/nyc-2026-11', '--identity-snapshot=s', '--export-csv=e'];
  assert.equal(p(...parityArgs, ...bounded).writtenBefore, Date.parse('2026-11-20T00:00:00Z'));
  assert.match(p(...parityArgs, '--written-before=2026-11-20T00:00:00Z').error, /--parity needs --expect-misses/);
  assert.match(p(...parityArgs, '--expect-misses=0').error, /--parity needs --written-before/);
  for (const bad of ['2026-11-20', '2026-11-20T00:00:00', 'yesterday', '']) {
    assert.match(p(...parityArgs, '--expect-misses=0', `--written-before=${bad}`).error,
      /--written-before takes an ISO instant with its zone/, bad);
  }
  assert.match(p('--dry-run', '--cache-root=a', '--plan=b', '--written-before=2026-11-20T00:00:00Z').error, /belongs to --parity/);
  assert.match(p(...parityArgs, ...bounded, '--feedback-snapshot=f').error, /not --parity/);
});

// ---------------------------------------------------------------------------
// No key, ever (NO KEY in the importer's header).
// ---------------------------------------------------------------------------
// Preloaded into a child with -r. Any read of a BESTTIME_API_KEY* variable's
// value through process.env is FORBIDDEN: it is recorded, with the file that
// made it, and throws. Also recorded: every file named .env opened, whether
// dotenv was ever loaded, and which of harvestVenueFilter.js and
// discoverBestTime.js were. SPY_LOAD_KEY sets a key the moment collectWeekly.js
// is loaded, as anything that brought one in after the first check would.
// Reported to SPY_OUT at exit.
const SPY = `
const fs = require('fs');
const path = require('path');
const Module = require('module');
const real = process.env;
const seen = { keyReads: [], envFiles: [], dotenvLoaded: false };
process.env = new Proxy(real, {
  get(t, k) {
    if (typeof k === 'string' && /^BESTTIME_API_KEY/i.test(k)) {
      const from = (new Error().stack.split('\\n').slice(2).find((l) => !l.includes('node:')) || '').trim();
      seen.keyReads.push({ name: k, from });
      throw new Error('a BestTime key variable was read');
    }
    return Reflect.get(t, k);
  },
});
for (const name of ['readFileSync', 'openSync', 'readFile', 'createReadStream']) {
  const inner = fs[name];
  fs[name] = function spied(p, ...rest) {
    if (typeof p === 'string' && path.basename(p) === '.env') seen.envFiles.push(path.resolve(p));
    return inner.call(this, p, ...rest);
  };
}
const load = Module._load;
Module._load = function spiedLoad(request, ...rest) {
  if (request === 'dotenv') seen.dotenvLoaded = true;
  const out = load.call(this, request, ...rest);
  if (/collectWeekly$/.test(request) && real.SPY_LOAD_KEY) real.BESTTIME_API_KEY = real.SPY_LOAD_KEY;
  return out;
};
process.on('exit', () => {
  const canaries = Object.entries(real).filter(([, v]) => /canary/.test(String(v))).map(([k]) => k);
  const loaded = Object.keys(require.cache).filter((f) => /harvestVenueFilter|discoverBestTime/.test(f)).map((f) => path.basename(f));
  fs.writeFileSync(real.SPY_OUT, JSON.stringify({ ...seen, canaries, loaded }));
});
`;

test('the import never holds or reads a key: cold start, refusals and error paths, with any key read forbidden', async () => {
  const { spawnSync } = require('node:child_process');
  const work = tmp('flock-import-nokey-');
  const spyFile = path.join(work, 'spy.js');
  fs.writeFileSync(spyFile, SPY);
  // A .env in the working folder, holding keys a default dotenv call would load.
  fs.writeFileSync(path.join(work, '.env'), 'BESTTIME_API_KEY=pri_canary_dotenv_0000000000\nBESTTIME_API_KEY_PUBLIC=pub_canary_dotenv_00000\n');
  const scripts = path.join(__dirname, '..', 'scripts', 'ml');
  const importer = path.join(scripts, 'train', 'importFilterCache.js');
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !KEY_NAME_RE.test(k)));
  const child = (name, env, args = [importer, '--dry-run', `--cache-root=${root}`, `--plan=${planFile}`]) => {
    const spyOut = path.join(work, `${name}.json`);
    const r = spawnSync(process.execPath, ['-r', spyFile, ...args], {
      cwd: work, env: { ...base, SPY_OUT: spyOut, ...env }, encoding: 'utf8', timeout: 120000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, spy: JSON.parse(fs.readFileSync(spyOut, 'utf8')) };
  };
  // Nothing loaded dotenv, opened a .env or read a key, and no canary arrived.
  const untouched = (c) => {
    assert.deepEqual(c.spy.keyReads, [], JSON.stringify(c.spy.keyReads));
    assert.equal(c.spy.dotenvLoaded, false, 'dotenv was loaded');
    assert.deepEqual(c.spy.envFiles, []);
    assert.deepEqual(c.spy.canaries, []);
    assert.doesNotMatch(c.out, /canary/);
  };

  // A key in the environment: refused before any module of the repository
  // loads, and its value never read.
  const set = child('set', { BESTTIME_API_KEY: 'pri_canary_env_000000000000' });
  assert.equal(set.status, 2, set.out);
  assert.match(set.out, /REFUSED: BESTTIME_API_KEY is set in the environment/);
  assert.doesNotMatch(set.out, /DRY RUN/);
  assert.deepEqual(set.spy.keyReads, []);
  assert.deepEqual(set.spy.loaded, [], 'harvestVenueFilter.js was loaded');

  // A key that arrives while the modules load: refused once they are,
  // before any answer is read, still by name.
  const loaded = child('loaded', { SPY_LOAD_KEY: 'pri_canary_loaded_0000000000' });
  assert.equal(loaded.status, 2, loaded.out);
  assert.match(loaded.out, /REFUSED: BESTTIME_API_KEY is set in this process once its modules were loaded/);
  assert.doesNotMatch(loaded.out, /canary|DRY RUN/);
  assert.deepEqual(loaded.spy.keyReads, []);

  // A cold start that runs: every module loaded (discoverBestTime.js
  // included), every refusal path of the fixture taken, and not one look at
  // a key, a dotenv or a .env.
  const clean = child('clean', {});
  assert.equal(clean.status, 0, clean.out);
  assert.match(clean.out, /DRY RUN \(nothing is written\)/);
  assert.deepEqual(clean.spy.loaded.sort(), ['discoverBestTime.js', 'harvestVenueFilter.js']);
  untouched(clean);

  // An error path of the import: a plan that is not there.
  const failed = child('failed', {}, [importer, '--dry-run', `--cache-root=${root}`, `--plan=${path.join(work, 'none.json')}`]);
  assert.equal(failed.status, 1, failed.out);
  assert.match(failed.out, /FAILED/);
  untouched(failed);

  // The harvester's own --offline command, whose database is not there: the
  // error is printed by logSafe with no key to screen for (an online run
  // reads both to screen it).
  const offline = child('offline', { DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none', PGSSLMODE: 'disable' },
    [path.join(scripts, 'harvestVenueFilter.js'), '--city=philly', '--offline', `--cache-dir=${work}`]);
  assert.equal(offline.status, 1, offline.out);
  assert.match(offline.out, /ABORTED: .*ECONNREFUSED/);
  untouched(offline);

  // In process too: run() refuses while one is set, by name.
  process.env.BESTTIME_API_KEY_PUBLIC = 'pub_canary_inprocess_000000';
  try {
    const { result, out } = await runImport(['--dry-run', ...baseArgs()]);
    assert.equal(result.exitCode, 2);
    assert.match(out, /REFUSED: BESTTIME_API_KEY_PUBLIC is set in this process/);
    assert.doesNotMatch(out, /canary/);
  } finally {
    delete process.env.BESTTIME_API_KEY_PUBLIC;
  }
});

// ---------------------------------------------------------------------------
// The dry run over the fixture cache.
// ---------------------------------------------------------------------------
test('a dry run refuses every city that fails a rule, by that rule, and never opens a holdout or training city\'s folder', async () => {
  const { result, out } = await runImport(['--dry-run', ...baseArgs()]);
  assert.equal(result.exitCode, 0, out);
  const c = result.report.cities;
  assert.deepEqual(reasons(c.miami), ['configCity']);
  assert.equal(c.miami.opened, false);
  assert.match(out, /Folders never opened: lehigh-2026-11-r10, miami-2026-11-r40\./);
  assert.deepEqual(reasons(c.tokyo), ['refusedCity']);
  assert.equal(c.tokyo.opened, false);
  // A training city's key on an entry the plan did not mark config.
  assert.deepEqual(reasons(c.lehigh), ['trainingCityKey']);
  assert.equal(c.lehigh.opened, false);
  // The partial city: stopped, and a question it never answered.
  assert.deepEqual(reasons(c.partialtown), ['cacherNotDone', 'missesNotNotFound']);
  assert.equal(c.partialtown.misses, 1);
  assert.equal(c.partialtown.notFound, 0);
  // A lost file is a miss that was not a 404.
  assert.deepEqual(reasons(c.missytown), ['inventoryMismatch', 'missesNotNotFound']);
  assert.equal(c.missytown.misses, c.missytown.notFound + 1);
  assert.match(c.missytown.reasons.find((x) => x.reason === 'inventoryMismatch').detail, /records listed 6, progress\.json 7/);
  // An answer the replay never asks for.
  assert.deepEqual(reasons(c.extratown), ['unusedFiles']);
  assert.equal(c.extratown.filesRead, c.extratown.filesHeld - 1);
  // No notFound to check misses against: refused twice over, by each check.
  assert.deepEqual(reasons(c.nocounttown), ['missesNotNotFound', 'noNotFoundCount']);
  assert.equal(c.nocounttown.notFound, null);
  // A record for another day in the very last answer, and a weekday whose
  // records all left the day out: every file read, the day check alone.
  // The record wrongdaytown's answer gained after it was cached is one the
  // cacher never counted, so its inventory disagrees too.
  assert.deepEqual(reasons(c.wrongdaytown), ['dayCheck', 'inventoryMismatch']);
  assert.match(c.wrongdaytown.reasons.find((x) => x.reason === 'inventoryMismatch').detail,
    /records listed 8, progress\.json 7; distinct venue ids 2, progress\.json 1;.* records for another day 1, progress\.json 0/);
  assert.deepEqual(reasons(c.nodaytown), ['dayCheck']);
  for (const key of ['wrongdaytown', 'nodaytown']) {
    assert.equal(c[key].filesRead, c[key].filesHeld, key);
    assert.equal(c[key].misses, c[key].notFound, key);
  }
  assert.match(c.wrongdaytown.reasons[0].detail, /for a different day/);
  assert.match(c.nodaytown.reasons[0].detail, /said which day/);
  assert.ok(c.nodaytown.unverifiable > 0);
  // An answer with no venue list stops the replay: named for what it is.
  assert.ok(reasons(c.brokentown).includes('replayAbort'), JSON.stringify(c.brokentown.reasons));
  assert.ok(!reasons(c.brokentown).includes('dayCheck'));
  assert.match(c.brokentown.reasons.find((r) => r.reason === 'replayAbort').detail, /without a venue list/);
  // A record with no curve: malformed in the merge, and a bad shape before it.
  assert.deepEqual(reasons(c.malformtown), ['invalidCurveShapes', 'malformedRecords']);
  assert.deepEqual([c.malformtown.malformed, c.malformtown.invalidCurveShapes], [1, 1]);
  // A string in one curve slot: nothing malformed, every file read, the
  // offline check alone, naming the city, the file, the record and the slot.
  assert.deepEqual(reasons(c.stringtown), ['invalidCurveValues']);
  assert.deepEqual([c.stringtown.malformed, c.stringtown.invalidCurveValues, c.stringtown.filesRead], [0, 1, c.stringtown.filesHeld]);
  assert.match(c.stringtown.reasons[0].detail, /stringtown [0-9a-f]{64}\.json record 0 day_int 1 slot 7 \(a string of 2 characters\)/);
  // A duplicate record with a 23-slot curve, which the merge never sees (and
  // the cacher never counted: it was added to the file afterwards).
  assert.deepEqual(reasons(c.duptown), ['invalidCurveShapes', 'inventoryMismatch']);
  assert.deepEqual([c.duptown.malformed, c.duptown.invalidCurveShapes, c.duptown.invalidCurveValues], [0, 1, 0]);
  assert.match(c.duptown.reasons.find((x) => x.reason === 'invalidCurveShapes').detail,
    new RegExp(`duptown ${dupFile.replace('.', '\\.')} record 1 day_int \\d \\(a list of 23\\)`));
  // A short page whose venues_n says one more venue was there.
  assert.deepEqual(reasons(c.shorttown), ['shortPageBelowTotal']);
  assert.equal(c.shorttown.shortOfTotal, 1);
  assert.match(c.shorttown.reasons[0].detail, new RegExp(`shorttown day_int \\d, paging ended at page 0 \\(${shortFile.replace('.', '\\.')}\\): `
    + '1 listed in the box, venues_n 2'));
  assert.deepEqual(reasons(c.movedtown), ['progressDisagrees']);
  assert.deepEqual(reasons(c.decembertown), ['monthUnknown']);
  assert.deepEqual(reasons(c.haltedtown), ['cacherNotDone', 'noFolder']);
  assert.equal(c.haltedtown.opened, false);
  assert.equal(c.unreachedville, undefined, 'a city the cacher never reached is neither accepted nor refused');
  assert.equal(result.report.totals.unreached, 1);
  const accepted = ['testville', 'twintown', 'nearphilly', 'nearmiami', 'nearbeijing', 'peaktown', 'bigcity', 'smallcity'];
  for (const key of accepted) {
    assert.equal(c[key].state, 'accepted', key);
    assert.equal(c[key].filesRead, c[key].filesHeld, `${key} left a file unread`);
    assert.equal(c[key].misses, c[key].notFound, key);
    assert.deepEqual([c[key].malformed, c[key].truncatedTiles, c[key].strayFiles, c[key].invalidCurveShapes,
      c[key].invalidCurveValues, c[key].shortOfTotal], [0, 0, 0, 0, 0, 0], key);
  }
  // Every replayed city reproduces the cacher's inventory unless its files
  // were damaged after the fact (or brokentown's first answer, which stops
  // the replay).
  const damagedAfter = ['missytown', 'wrongdaytown', 'duptown', 'brokentown'];
  for (const [key, city] of Object.entries(c)) {
    if (city.filesHeld === undefined) continue;
    assert.equal((city.reasons || []).some((x) => x.reason === 'inventoryMismatch'), damagedAfter.includes(key), key);
  }
  assert.equal(result.report.totals.accepted, accepted.length);
  assert.match(out, /malformed 0 {2}no day 0 {2}cut 0 {2}stray 0 {2}bad curves 0 {2}bad slots 0 {2}short of total 0/);
});

test('a box still at the 500 cap at the smallest tile refuses its city: venues there were never listed', async () => {
  // 500 listings on one spot, off every tile edge: each split leaves them in
  // one quarter until the box cannot split, every day of the week.
  const c = { key: 'crowdedtown', lat: -32.0004, lon: -29.9996, radiusKm: 5 };
  const crowd = Array.from({ length: 500 }, (_, i) => vn(`ven_crowd_${String(i).padStart(3, '0')}`, c.lat, c.lon, 'RESTAURANT',
    `ChIJcrowdedtown${String(i).padStart(6, '0')}`, weekFor(i)));
  const single = await singleCityRoot(c, crowd);
  const { result, out } = await runImport(['--dry-run', `--cache-root=${single.root}`, `--plan=${single.plan}`]);
  assert.equal(result.exitCode, 0, out);
  const r = result.report.cities.crowdedtown;
  assert.deepEqual(reasons(r), ['truncatedTiles']);
  assert.equal(r.truncatedTiles, 7, 'one smallest box, seven days');
  assert.deepEqual([r.filesRead, r.misses, r.notFound, r.malformed], [r.filesHeld, 0, 0, 0]);
  assert.match(r.reasons[0].detail, /7 boxes reached the 500 cap at the smallest tile/);
  assert.equal(result.report.totals.accepted, 0);
});

test('a saturated box whose answers are gone with every box below it is refused by the cacher\'s inventory', async () => {
  // The first tile holds over 500 venues, so it saturates and splits; one
  // quarter is empty and 404s on all seven days. Another tile holds a venue.
  const c = { key: 'subtreetown', lat: -36.0, lon: -30.0, radiusKm: 12 };
  const centroids = { [c.key]: { lat: c.lat, lon: c.lon } };
  const tiles = H.planTiles([c.key], 20, c.radiusKm, centroids).map((p) => p.tile);
  assert.ok(tiles.length >= 2, String(tiles.length));
  const [top] = tiles;
  const quarters = H.splitTile(top).filter((k) => H.tileIntersects(k, [c.key], c.radiusKm, centroids));
  assert.ok(quarters.length >= 3, String(quarters.length));
  const full = quarters.slice(0, -1);
  const per = Math.ceil(510 / full.length);
  const at = (k) => [(k.s + k.n) / 2000, (k.w + k.e) / 2000];
  const crowd = full.flatMap((k, q) => Array.from({ length: per }, (_, i) => vn(`ven_sub_${q}_${String(i).padStart(3, '0')}`,
    ...at(k), 'RESTAURANT', `ChIJsubtree${q}${String(i).padStart(6, '0')}`, weekFor(i))));
  const [elseLat, elseLng] = at(tiles[1]);
  const elsewhere = vn('ven_sub_else', elseLat, elseLng, 'BAR', 'ChIJsubtreeElsewhere01', weekFor(3));
  const single = await singleCityRoot(c, [...crowd, elsewhere], { notFoundWhen: ({ inBox }) => inBox.length === 0 });
  assert.ok(single.inventory.splits >= 1 && single.notFound >= 7);
  const dry = () => runImport(['--dry-run', `--cache-root=${single.root}`, `--plan=${single.plan}`]);
  const whole = (await dry()).result.report.cities.subtreetown;
  assert.equal(whole.state, 'accepted', JSON.stringify(whole.reasons));
  // Every answer of the top box and of every box below it, gone: the replay
  // asks the top box, finds nothing, and so asks nothing below it. Its seven
  // misses stand in for the seven 404s below, and no file is left unread.
  const inside = (u) => {
    const p = new URL(u).searchParams;
    const [s, w, n, e] = ['lat_min', 'lng_min', 'lat_max', 'lng_max'].map((k) => Math.round(Number(p.get(k)) * 1000));
    return s >= top.s && n <= top.n && w >= top.w && e <= top.e;
  };
  let gone = 0;
  for (const f of fs.readdirSync(single.dir)) {
    if (inside(JSON.parse(fs.readFileSync(path.join(single.dir, f), 'utf8')).url)) { fs.unlinkSync(path.join(single.dir, f)); gone++; }
  }
  assert.ok(gone > 7, String(gone));
  const { result, out } = await dry();
  const r = result.report.cities.subtreetown;
  assert.deepEqual([r.misses, r.filesRead, r.malformed], [r.notFound, r.filesHeld, 0], 'every older rule passes it');
  assert.deepEqual(reasons(r), ['inventoryMismatch'], out);
  assert.match(r.reasons[0].detail, /questions asked \(requests \+ cachedPages\) [\d,]+, progress\.json [\d,]+; records listed 7, progress\.json [\d,]+; distinct venue ids 1, progress\.json [\d,]+;.* splits 0, progress\.json [1-9]/);
  // No inventory to hold it to, or one whose requests include retries:
  // refused, never taken as matching.
  const progressFile = path.join(single.root, 'progress.json');
  const kept = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  for (const [change, pattern] of [
    [(p) => { delete p.cities.subtreetown.distinctVenues; }, /progress\.json records no distinctVenues for it/],
    [(p) => { p.totals.throttled = 1; }, /the cacher's run retried requests/],
    [(p) => { delete p.totals; }, /kept no throttled or networkErrors totals/],
  ]) {
    const p = JSON.parse(JSON.stringify(kept));
    change(p);
    fs.writeFileSync(progressFile, JSON.stringify(p));
    const again = (await dry()).result.report.cities.subtreetown;
    assert.ok(reasons(again).includes('noInventory'), JSON.stringify(again.reasons));
    assert.match(again.reasons.find((x) => x.reason === 'noInventory').detail, pattern);
  }
});

test('one global placement: training-city, holdout and beijing venues are dropped, a venue in two circles counts once', async () => {
  const { result } = await runImport(['--dry-run', ...baseArgs()]);
  const c = result.report.cities;
  const t = result.report.totals;
  assert.deepEqual(c.nearphilly.drops, { placedInTrainingCity: 1 });
  assert.equal(c.nearphilly.kept, 0);
  assert.deepEqual(t.placedInTrainingCity, { philly: 1 });
  // Nearer Miami; and nearer nearmiami but 21 km from Miami.
  assert.deepEqual(c.nearmiami.drops, { placedInHoldoutCity: 1, within80kmOfHoldoutOrBeijing: 1 });
  assert.equal(c.nearmiami.kept, 0);
  assert.deepEqual(c.nearbeijing.drops, { placedInBeijing: 1, within80kmOfHoldoutOrBeijing: 1 });
  assert.equal(c.nearbeijing.kept, 0);
  assert.equal(t.keptWithin80kmOfHoldoutOrBeijing, 0);
  // Placed nearer the refused haltedtown, a market though it is refused.
  assert.equal(c.testville.drops.placedInRefusedCacheCity, 1);
  assert.equal(keptOf(result, T.edge.id).length, 0);
  // The two venues in both circles are each one venue, and each takes its
  // record from the city it is placed in, filling only the days that lacks.
  assert.equal(t.venuesInTwoCircles, 2);
  assert.equal(t.daysFilledFromAnotherCity, 1);
  assert.equal(c.twintown.venuesFound, 5);
  assert.equal(c.twintown.homeVenues, 4);
  assert.equal(c.twintown.kept, 4);
  const [shared] = keptOf(result, T.shared.id);
  assert.equal(keptOf(result, T.shared.id).length, 1);
  assert.deepEqual([shared.city, shared.daysHeld, shared.rows], ['testville', 7, 168]);
  const [both] = keptOf(result, W.both.id);
  assert.equal(keptOf(result, W.both.id).length, 1);
  assert.deepEqual([both.city, both.venue.reviews, both.foundIn], ['twintown', 200, ['testville', 'twintown']]);
  // testville before the snapshot: the harvest's own new-venue rules only.
  assert.deepEqual(c.testville.drops, {
    outsideRadius: 1, noPlaceId: 1, noName: 1, nearDuplicateInRun: 1, placedInRefusedCacheCity: 1,
  });
  assert.equal(c.testville.kept, 8);
  // Inside bigcity's 30 km circle, nearer smallcity, outside its 5 km: kept,
  // in smallcity. In bigcity's box but inside neither circle: dropped.
  const [edge] = keptOf(result, BC.edge.id);
  assert.equal(edge && edge.city, 'smallcity');
  assert.deepEqual(c.smallcity.drops, { outsideRadius: 1 });
  assert.deepEqual([c.bigcity.kept, c.smallcity.kept], [1, 2]);
  assert.equal(keptOf(result, BC.beyond.id).length, 0);
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
  assert.equal(d.knownNearDuplicate, 1);
  assert.equal(d.within2kmOfCorpusVenue, 1);
  const kept = new Set(result.kept.map((k) => k.venue.venueId));
  for (const v of [T.knownBt, T.knownPlace, T.near, T.nearDup]) assert.ok(!kept.has(v.id), v.id);
  // 2.5 km from a corpus row is kept, and so is a venue only the export
  // would show near one, when no export is given.
  assert.ok(kept.has(T.cafe.id));
  assert.ok(kept.has(W.exportNear.id));
  assert.equal(result.report.totals.identityRules, 'applied');
  assert.equal(result.report.totals.keepAwayRule, 'applied (snapshot only)');
  assert.match(out, /6 ml_venues rows/);
  assert.match(out, /the table held 6 rows, ids 101 to 106, every one in the CSV/);
  assert.equal(result.report.totals.snapshotCompleteness.proven, true);
});

test('the twin rule and identity rule 4 reach every cell 40 m can: one either side below 68.9 degrees, two at 70, and across the antimeridian', () => {
  const reach = (lat) => H.cellsWithin(lat, H.NEAR_DUP_METERS / 1000, 0.001);
  for (const lat of [0, 35, -45, 60, 64.3, 68.9]) assert.deepEqual(reach(lat), { lat: 1, lng: 1 }, String(lat));
  assert.deepEqual([reach(70), reach(-70)], [{ lat: 1, lng: 2 }, { lat: 1, lng: 2 }]);
  // Two listings of one bar 38.8 m apart at 70 degrees, two longitude cells
  // apart (20000 and 20002): before, both were kept as new venues.
  const days = new Map([[0, Array(24).fill(30)]]);
  const bar = (id, lng, placeId) => ({ venueId: id, name: 'Nordlys Bar', placeId, rawPlaceId: placeId, lat: 70.0005, lng, type: 'BAR', days });
  const a = bar('ven_arctic_a', 20.00099, 'ChIJarcticBarA0000001');
  const b = bar('ven_arctic_b', 20.00201, 'ChIJarcticBarB0000001');
  const m = kmBetween(a.lat, a.lng, b.lat, b.lng) * 1000;
  assert.ok(m > 38.5 && m < 39, String(m));
  assert.deepEqual([Math.floor(a.lng * 1000), Math.floor(b.lng * 1000)], [20000, 20002]);
  const opts = { markets: { arctic: { lat: 70.0, lon: 20.0 } }, insideRadius: () => true };
  const twins = H.planVenues([a, b], { byBtId: new Map(), byPlaceId: new Map(), nearby: [] }, ['arctic'], opts);
  assert.deepEqual(twins.plan.map((p) => [p.kind, p.venue.venueId]), [['new', a.venueId]]);
  assert.equal(twins.skipped.nearDuplicateInRun, 1);
  // A corpus row under the same name two cells off is the venue (rule 4).
  const row = { id: 7, name: 'Nordlys Bar', latitude: b.lat, longitude: b.lng, besttime_venue_id: null, google_place_id: 'ChIJarcticRow00000001' };
  const known = H.planVenues([a], { byBtId: new Map(), byPlaceId: new Map(), nearby: [row] }, ['arctic'], opts);
  assert.deepEqual(known.plan.map((p) => [p.kind, p.row && p.row.id]), [['known_near', 7]]);
  // Across the antimeridian: 179.9999 and -179.9999 at the equator, 22 m
  // apart, are one venue, as a twin and against a corpus row.
  const east = { ...bar('ven_dateline_a', 179.9999, 'ChIJdatelineBarA00001'), lat: 0, name: 'Dateline Bar' };
  const west = { ...bar('ven_dateline_b', -179.9999, 'ChIJdatelineBarB00001'), lat: 0, name: 'Dateline Bar' };
  assert.ok(kmBetween(east.lat, east.lng, west.lat, west.lng) * 1000 < 23);
  const datelineOpts = { markets: { dateline: { lat: 0, lon: 180 } }, insideRadius: () => true };
  const pair = H.planVenues([east, west], { byBtId: new Map(), byPlaceId: new Map(), nearby: [] }, ['dateline'], datelineOpts);
  assert.deepEqual(pair.plan.map((p) => [p.kind, p.venue.venueId]), [['new', east.venueId]]);
  assert.equal(pair.skipped.nearDuplicateInRun, 1);
  const corpusRow = { id: 8, name: 'Dateline Bar', latitude: 0, longitude: 179.9999, besttime_venue_id: null,
    google_place_id: 'ChIJdatelineRow000001' };
  const held = H.planVenues([west], { byBtId: new Map(), byPlaceId: new Map(), nearby: [corpusRow] }, ['dateline'], datelineOpts);
  assert.deepEqual(held.plan.map((p) => [p.kind, p.row && p.row.id]), [['known_near', 8]]);
});

test('offline, a box whose paging ends below the venues_n any page declared is counted, on a short page or a missing one', async () => {
  // Answers written by hand into a cache, as the harvester names them.
  const dir = tmp('flock-import-pages-');
  const opts = { cacheDir: dir, offline: true, pageSize: 100, resultCap: 500, allTypes: false, askPlaceId: true };
  const tile = { s: 10000, w: 10000, n: 10010, e: 10010 };
  const put = (day, page, count, venuesN) => {
    const keyless = H.cacheKeyUrl(H.buildFilterUrl(H.OFFLINE_KEY, { tile, day, page }, opts));
    const venues = Array.from({ length: count }, (_, i) => ({ venue_id: `ven_page_${day}_${page}_${i}`, day_int: day,
      day_raw_whole: Array(24).fill(10) }));
    fs.writeFileSync(path.join(dir, H.cacheFileName(keyless)), JSON.stringify({ url: keyless, fetchedAt: FETCHED_AT,
      data: { status: 'OK', venues, venues_n: venuesN } }));
  };
  put(0, 0, 100, 150); // page 0 says 150, page 1 lists 49: 149 in all
  put(0, 1, 49, 49);
  put(1, 0, 100, 149); // page 0 says 149, and page 1 has no answer
  put(2, 0, 100, 100); // venues_n per page, as every real answer: nothing wrong
  put(2, 1, 49, 49);
  const seen = [];
  const ctx = {
    key: H.OFFLINE_KEY, opts, stats: H.emptyStats(), city: H.emptyCityStats(1), otherDays: new Map(), dayTally: new Map(),
    onShortOfTotal: (x) => seen.push(x),
  };
  const counts = [];
  for (const day of [0, 1, 2]) counts.push((await H.fetchTile(ctx, tile, day)).venues.length);
  assert.deepEqual(counts, [149, 100, 149]);
  assert.equal(ctx.stats.shortOfTotal, 2);
  assert.equal(ctx.stats.cacheMisses, 1);
  assert.deepEqual(seen.map((x) => [x.day, x.page, x.collected, x.total, x.miss]), [[0, 1, 149, 150, false], [1, 1, 100, 149, true]]);
  // Online, nothing of the kind is counted.
  const online = { ...ctx, opts: { ...opts, offline: false }, stats: H.emptyStats() };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('the network was reached'); };
  try {
    await H.fetchTile(online, tile, 0);
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(online.stats.shortOfTotal, 0);
});

// --write's arguments with another snapshot and another reference.
const writeArgsWith = (outDir, { snap = snapshotFile, ref = refDir, feedback = feedbackFile } = {}) => ['--write', ...baseArgs(),
  `--identity-snapshot=${snap}`, `--export-dir=${exportDir}`, `--harvest-cache=${ref}`, `--out-dir=${outDir}`,
  `--feedback-snapshot=${feedback}`];
const nothingWritten = (outDir) => Object.values(I.OUTPUT_FILES).every((f) => !fs.existsSync(path.join(outDir, f)));

test('the snapshot must prove it is the whole table: no meta, a row short, a changed byte or a WHERE refuses --write', async () => {
  const dir = tmp('flock-import-snap-');
  const full = fs.readFileSync(snapshotFile, 'utf8');
  const copy = (name, text = full) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  const refused = async (snap, pattern) => {
    const outDir = tmp('flock-import-out-');
    const { result, out } = await runImport(writeArgsWith(outDir, { snap }));
    assert.equal(result.exitCode, 1, out);
    assert.match(out, pattern);
    assert.doesNotMatch(out, /BY CITY/, 'refused before any folder is replayed');
    assert.ok(nothingWritten(outDir));
    return out;
  };
  // No meta: --write refuses; a dry run goes on and says completeness is unproven.
  const bare = copy('bare.csv');
  await refused(bare, /no bare\.meta\.json beside the snapshot: nothing shows it is the whole of ml_venues/);
  const dry = await runImport(['--dry-run', ...baseArgs(), `--identity-snapshot=${bare}`]);
  assert.equal(dry.result.exitCode, 0, dry.out);
  assert.match(dry.out, /COMPLETENESS IS UNPROVEN/);
  assert.equal(dry.result.report.totals.snapshotCompleteness.proven, false);
  // The unlabelled venue left out: in neither export file, so only the meta
  // can show it. The CSV hashes as written; the table held one row more.
  const short = copy('short.csv', full.split('\n').filter((l) => !l.startsWith('106,')).join('\n'));
  writeSnapshotMeta(short, { tableCount: 6, tableMaxId: 106 });
  await refused(short, /the CSV holds 5 rows; the table held 6 and 5 were written; its last id is 105; the table's highest was 106/);
  // A dry run refuses a meta that disagrees, too.
  const dryShort = await runImport(['--dry-run', ...baseArgs(), `--identity-snapshot=${short}`]);
  assert.equal(dryShort.result.exitCode, 1);
  // One byte changed after the meta was written.
  const edited = copy('edited.csv');
  writeSnapshotMeta(edited);
  fs.writeFileSync(edited, full.replace('Far Row', 'Far Rov'));
  await refused(edited, /its csvSha256 [0-9a-f]{64} is not the CSV's [0-9a-f]{64}/);
  // Taken with a WHERE: every count agrees with the CSV, and it is still not the table.
  const where = copy('where.csv');
  writeSnapshotMeta(where, { query: I.SNAPSHOT_QUERY.replace('FROM ml_venues', 'FROM ml_venues WHERE is_active') });
  await refused(where, /its query is not SNAPSHOT_QUERY/);
});

test('the feedback columns are proven 0: --write needs a whole feedback snapshot, and refuses a kept venue with a verified report', async () => {
  const dir = tmp('flock-import-feedback-');
  const refused = async (feedback, pattern) => {
    const outDir = tmp('flock-import-out-');
    const { result, out } = await runImport(writeArgsWith(outDir, { feedback }));
    assert.equal(result.exitCode, 1, out);
    assert.match(out, pattern);
    assert.ok(nothingWritten(outDir));
    return out;
  };
  // Required by --write, and by nothing else.
  const noArg = writeArgsWith('o').filter((a) => !a.startsWith('--feedback-snapshot='));
  assert.match(I.parseImportArgs(['node', 'x', ...noArg]).error, /--write needs --feedback-snapshot/);
  // No meta beside it: nothing shows it holds every verified report.
  const bare = path.join(dir, 'bare.csv');
  fs.writeFileSync(bare, 'venue_place_id,verified_reports\n');
  await refused(bare, /no bare\.meta\.json beside the feedback snapshot/);
  // A byte changed after the meta, another query, a count that does not add up.
  const edited = writeFeedbackSnapshot(path.join(dir, 'edited.csv'), [['ChIJsomewhereElse000001', 2]]);
  fs.appendFileSync(edited, 'ChIJsomewhereElse000002,1\n');
  await refused(edited, /its csvSha256 [0-9a-f]{64} is not the CSV's/);
  const unverified = writeFeedbackSnapshot(path.join(dir, 'unverified.csv'), [['ChIJsomewhereElse000001', 2]],
    { query: 'SELECT venue_place_id, COUNT(*)::int AS verified_reports FROM venue_feedback WHERE venue_place_id IS NOT NULL '
      + 'GROUP BY venue_place_id ORDER BY venue_place_id' });
  await refused(unverified, /its query is not FEEDBACK_QUERY/);
  const short = writeFeedbackSnapshot(path.join(dir, 'short.csv'), [['ChIJsomewhereElse000001', 2]], { tableVerifiedCount: 1 });
  await refused(short, /the table held 1 verified reports; the CSV counts 2/);
  const allCounted = writeFeedbackSnapshot(path.join(dir, 'allcounted.csv'), [['ChIJsomewhereElse000001', 2]],
    { countQuery: 'SELECT COUNT(*) FROM venue_feedback' });
  await refused(allCounted, /its countQuery is not FEEDBACK_COUNT_QUERY/);
  const written = writeFeedbackSnapshot(path.join(dir, 'written.csv'), [['ChIJsomewhereElse000001', 2]], { verifiedReportsWritten: 1 });
  await refused(written, /the CSV counts 2 reports; 1 were written/);
  // A verified report for a venue that would be written (twintown's bar).
  const hit = writeFeedbackSnapshot(path.join(dir, 'hit.csv'), [[W.bar.placeId, 3], ['ChIJsomewhereElse000001', 2]]);
  const hitOut = await refused(hit, new RegExp(`1 kept venues have verified venue_feedback reports \\(first place ids ${W.bar.placeId}\\)`));
  assert.doesNotMatch(hitOut, /WROTE/);
  // A dry run says so and goes on.
  const dry = await runImport(['--dry-run', ...baseArgs(), `--feedback-snapshot=${hit}`]);
  assert.equal(dry.result.exitCode, 0, dry.out);
  assert.deepEqual([dry.result.report.totals.feedback.keptWithReports, dry.result.report.totals.feedback.firstKeptWithReports],
    [1, [W.bar.placeId]]);
  const none = await runImport(['--dry-run', ...baseArgs()]);
  assert.match(none.out, /FEEDBACK SNAPSHOT: none given, so the rows' feedback columns \(0, 0, 0\) are UNPROVEN/);
});

test('the peak-hour check is never passed by a reference that cannot make it: empty, unreadable or missing a category', async () => {
  const empty = tmp('flock-import-ref-empty-');
  const unreadable = tmp('flock-import-ref-bad-');
  fs.mkdirSync(path.join(unreadable, 'philly-2026-11'));
  fs.writeFileSync(path.join(unreadable, 'philly-2026-11', `${'a'.repeat(64)}.json`), 'not json');
  // Philly's bars and restaurants, and no nightclub.
  const barsOnly = tmp('flock-import-ref-bars-');
  fs.mkdirSync(path.join(barsOnly, 'philly-2026-11'));
  const bars = Array.from({ length: 30 }, (_, i) => vn(`ven_refb_bar_${i}`, 39.95 + i * 0.001, -75.16, 'BAR', null, peakWeek(22)));
  for (let d = 0; d < 7; d++) {
    const name = `${crypto.createHash('sha256').update(`refb-${d}`).digest('hex')}.json`;
    fs.writeFileSync(path.join(barsOnly, 'philly-2026-11', name), JSON.stringify({ url: `refb-${d}`, fetchedAt: FETCHED_AT,
      data: { venues: bars.map((v) => record(v, d)) } }));
  }
  const all = { testville: ['bar'], twintown: ['bar', 'nightclub'], peaktown: ['bar', 'nightclub'] };
  for (const [ref, want] of [[empty, all], [unreadable, all], [barsOnly, { twintown: ['nightclub'], peaktown: ['nightclub'] }]]) {
    const dry = await runImport(['--dry-run', ...baseArgs(), `--harvest-cache=${ref}`]);
    assert.equal(dry.result.exitCode, 0, dry.out);
    assert.deepEqual(dry.result.report.totals.peakUnavailable, want, ref);
    const n = Object.values(want).flat().length;
    assert.equal(dry.result.report.totals.peakCheck, `run, ${n} bar or nightclub comparisons unavailable`);
    assert.deepEqual(dry.result.report.cities.twintown.peakUnavailable, want.twintown);
    assert.match(dry.out, new RegExp(`PEAK COMPARISONS UNAVAILABLE \\(${n};`));
    assert.match(dry.out, /nightclub 01h n=1 NO REFERENCE/);
    const outDir = tmp('flock-import-out-');
    const w = await runImport(writeArgsWith(outDir, { ref }));
    assert.equal(w.result.exitCode, 1, w.out);
    assert.match(w.out, /REFUSED: the peak-hour check could not compare peaktown \(/);
    assert.ok(nothingWritten(outDir));
  }
  // The full reference makes every comparison.
  const full = await runImport(['--dry-run', ...baseArgs(), `--harvest-cache=${refDir}`]);
  assert.deepEqual(full.result.report.totals.peakUnavailable, {});
  assert.equal(full.result.report.totals.peakCheck, 'run');
});

test('with the export, its positions join the 2 km rule, and an export the snapshot does not cover is refused', async () => {
  const { result, out } = await runImport(['--dry-run', ...baseArgs(), `--identity-snapshot=${snapshotFile}`,
    `--export-dir=${exportDir}`]);
  assert.equal(result.exitCode, 0, out);
  assert.deepEqual(result.report.cities.twintown.drops, { within2kmOfCorpusVenue: 1 });
  assert.equal(keptOf(result, W.exportNear.id).length, 0);
  assert.equal(result.report.totals.keepAwayRule, 'applied (snapshot and export)');
  assert.equal(result.report.totals.exportChecked.length, 2);
  // A venue the export holds and the snapshot lacks: a partial or stale
  // snapshot. Refused before any folder is replayed.
  const absent = await runImport(['--dry-run', ...baseArgs(), `--identity-snapshot=${snapshotFile}`, `--export-dir=${absentExportDir}`]);
  assert.equal(absent.result.exitCode, 1);
  assert.match(absent.out, /1 of the 2 venues the export holds are not in the snapshot \(first ids 999\)/);
  assert.doesNotMatch(absent.out, /BY CITY/);
  const twice = await runImport(['--dry-run', ...baseArgs(), `--identity-snapshot=${snapshotFile}`, `--export-dir=${cacheExportDir}`]);
  assert.equal(twice.result.exitCode, 1);
  assert.match(twice.out, /already holds cache rows/);
});

test('the peak-hour check flags a bar or nightclub mode 3 hours or more off, either way, and nothing 2 hours off', async () => {
  const { result, out } = await runImport(['--dry-run', ...baseArgs(), `--harvest-cache=${refDir}`]);
  assert.equal(result.exitCode, 0, out);
  assert.deepEqual(result.flagged, ['peaktown', 'testville']);
  const peaks = (key, category) => {
    const p = result.report.cities[key].peaks[category];
    return [p.mode, p.reference, p.shift, p.flag];
  };
  assert.deepEqual(peaks('testville', 'bar'), [18, 22, -4, true]);
  assert.deepEqual(peaks('peaktown', 'bar'), [19, 22, -3, true]);
  assert.deepEqual(peaks('peaktown', 'nightclub'), [2, 23, 3, true]);
  assert.deepEqual(peaks('twintown', 'bar'), [0, 22, 2, false]);
  assert.deepEqual(peaks('twintown', 'nightclub'), [1, 23, 2, false]);
  assert.equal(result.report.cities.twintown.peakFlag, false);
  assert.match(out, /PEAK FLAGS \(2/);
});

// ---------------------------------------------------------------------------
// --write.
// ---------------------------------------------------------------------------
const writeArgs = (outDir) => ['--write', ...baseArgs(), `--identity-snapshot=${snapshotFile}`, `--export-dir=${exportDir}`,
  `--harvest-cache=${refDir}`, `--out-dir=${outDir}`, `--feedback-snapshot=${feedbackFile}`];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('--write writes the export\'s rows under world_cache, a sidecar and a manifest, leaving flagged cities out', async () => {
  const outDir = tmp('flock-import-out-');
  const args = writeArgs(outDir);
  const { result, out } = await runImport(args);
  assert.equal(result.exitCode, 0, out);
  assert.deepEqual(result.manifest.rules.refusedForPeakFlags, ['peaktown', 'testville']);
  const sidecar = I.parseCsv(fs.readFileSync(path.join(outDir, 'cache_venues.csv'), 'utf8')).filter((r) => r.length > 1);
  assert.deepEqual(sidecar.slice(1).map((r) => [r[0], r[1], r[2]]), [
    ['1000000000', 'bigcity', BC.home.id],
    ['1000000001', 'smallcity', BC.edge.id],
    ['1000000002', 'smallcity', SC.home.id],
    ['1000000003', 'twintown', W.bar.id],
    ['1000000004', 'twintown', W.both.id],
    ['1000000005', 'twintown', W.club.id],
  ]);
  // The export's two files, by hash.
  const files = result.manifest.inputs.export.files;
  assert.deepEqual(files.map((f) => [f.file, f.sha256]), ['training_data.csv', 'holdout_data.csv']
    .map((f) => [f, sha(path.join(exportDir, f))]));
  // A second write into the same folder is refused, and so is accepting a
  // city that was never flagged.
  const again = await runImport(args);
  assert.equal(again.result.exitCode, 1);
  assert.match(again.out, /already holds cache_rows\.csv/);
  const wrongAccept = await runImport([...writeArgs(tmp('flock-import-out-')), '--accept-peak-flags=twintown']);
  assert.equal(wrongAccept.result.exitCode, 1);
  assert.match(wrongAccept.out, /not flagged: twintown/);
});

test('--write with a flag accepted: every row is the export\'s, ids from 1,000,000,000, hashes in the manifest', async () => {
  const outDir = tmp('flock-import-out-');
  const { result, out } = await runImport([...writeArgs(outDir), '--accept-peak-flags=testville']);
  assert.equal(result.exitCode, 0, out);
  assert.deepEqual(result.manifest.rules.refusedForPeakFlags, ['peaktown']);
  const rowsFile = path.join(outDir, 'cache_rows.csv');
  const text = fs.readFileSync(rowsFile, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines[0], exporter.HEADER);
  const rows = lines.slice(1).map((l) => I.parseCsv(l)[0]);
  const sidecar = I.parseCsv(fs.readFileSync(path.join(outDir, 'cache_venues.csv'), 'utf8')).filter((r) => r.length > 1).slice(1);
  // By city, then BestTime id within it.
  assert.deepEqual(sidecar.map((r) => [Number(r[0]), r[1], r[2]]), [
    [1000000000, 'bigcity', BC.home.id],
    [1000000001, 'smallcity', BC.edge.id],
    [1000000002, 'smallcity', SC.home.id],
    [1000000003, 'testville', T.bar.id],
    [1000000004, 'testville', T.restaurant.id],
    [1000000005, 'testville', T.cafe.id],
    [1000000006, 'testville', T.shared.id],
    [1000000007, 'twintown', W.bar.id],
    [1000000008, 'twintown', W.both.id],
    [1000000009, 'twintown', W.club.id],
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
  assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 10 }, (_, n) => 1000000000 + n));
  const of = (id) => rows.filter((r) => r[col('venue_id')] === String(id));
  assert.equal(of(1000000003).length, 168);
  assert.deepEqual([of(1000000004)[0][col('rating')], of(1000000004)[0][col('review_count')]], ['4.4', '120']);
  assert.deepEqual([of(1000000005)[0][col('rating')], of(1000000005)[0][col('review_count')]], ['4.0', '']);
  assert.equal(of(1000000007)[0][col('venue_category')], 'bar');
  // The shared venue's Thursday came from twintown's answers.
  assert.equal(of(1000000006).length, 168);
  // The venue placed in twintown carries twintown's answer.
  assert.equal(of(1000000008)[0][col('review_count')], '200');
  // Monday 6 AM is BestTime Monday slot 0.
  const cafeMon6 = of(1000000005).find((r) => r[col('day_of_week')] === '1' && r[col('hour')] === '6');
  assert.equal(Number(cafeMon6[col('busyness_pct')]), T.cafe.week[0][0]);
  const local = bestTimeSlotToLocal(20, bestTimeDayToJsDay(5));
  const cafeSat20 = of(1000000005).find((r) => r[col('day_of_week')] === String(local.dayOfWeek) && r[col('hour')] === String(local.hour));
  assert.equal(Number(cafeSat20[col('busyness_pct')]), T.cafe.week[5][20]);
  // The manifest's hashes are the files'.
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'cache_manifest.json'), 'utf8'));
  assert.equal(manifest.outputs.rows.sha256, sha(rowsFile));
  assert.equal(manifest.outputs.venues.sha256, sha(path.join(outDir, 'cache_venues.csv')));
  assert.equal(manifest.outputs.rows.dataRows, rows.length);
  assert.equal(manifest.inputs.identitySnapshot.sha256, sha(snapshotFile));
  assert.deepEqual(manifest.inputs.identitySnapshot.meta, {
    file: I.snapshotMetaFile(snapshotFile), snapshotAt: '2026-11-25T19:31:05.168Z', tableCount: 6, csvSha256: sha(snapshotFile),
  });
  assert.deepEqual(manifest.inputs.feedbackSnapshot, {
    file: feedbackFile, sha256: sha(feedbackFile), placeIds: 1, verifiedReports: 2, keptWithReports: 0,
    meta: { file: I.snapshotMetaFile(feedbackFile), snapshotAt: '2026-11-25T22:01:00.000Z', tableVerifiedCount: 2, csvSha256: sha(feedbackFile) },
  });
  assert.equal(manifest.inputs.plan.sha256, sha(planFile));
  assert.equal(manifest.inputs.export.files[0].sha256, sha(path.join(exportDir, 'training_data.csv')));
  assert.ok(manifest.git.commit === null || /^[0-9a-f]{40}$/.test(manifest.git.commit), String(manifest.git.commit));
  assert.deepEqual(manifest.outputs.syntheticIds, { first: 1000000000, last: 1000000009 });
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
  // No key in the environment is needed (none is set: see the requires).
  assert.deepEqual(Object.keys(process.env).filter((n) => KEY_NAME_RE.test(n)), []);
  {
    const before = await countRows();
    // Not even looked for: every read of a key variable during the run.
    const realEnv = process.env;
    const keyReads = [];
    process.env = new Proxy(realEnv, {
      get(t, k) {
        if (typeof k === 'string' && KEY_NAME_RE.test(k)) keyReads.push(k);
        return Reflect.get(t, k);
      },
    });
    let dry;
    try {
      dry = await harvestOffline(['--city=philly', '--new-only', '--offline', `--cache-dir=${phillyDir}`]);
    } finally {
      process.env = realEnv;
    }
    assert.deepEqual(keyReads, []);
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
  }
  // A damaged copy: a string in one curve slot, and a short page whose
  // venues_n says one more venue was there. Refused before planning.
  const damagedDir = path.join(tmp('flock-import-philly-damaged-'), 'philly-2026-11');
  fs.cpSync(phillyDir, damagedDir, { recursive: true });
  const listing = fs.readdirSync(damagedDir).filter((f) => {
    const n = JSON.parse(fs.readFileSync(path.join(damagedDir, f), 'utf8')).data.venues.length;
    return n > 0 && n < 100;
  });
  rewriteAnswer(path.join(damagedDir, listing[0]), (entry) => { entry.data.venues[0].day_raw_whole[3] = null; });
  rewriteAnswer(path.join(damagedDir, listing[1]), (entry) => { entry.data.venues_n = entry.data.venues.length + 1; });
  const damaged = await harvestOffline(['--city=philly', '--new-only', '--offline', `--cache-dir=${damagedDir}`]);
  assert.equal(damaged.summary.aborted, true);
  assert.match(damaged.summary.abortReason, /REFUSED: 0 records in --cache-dir had no 24-slot curve, 1 curve slots were no number from 0 to 100, and 1 boxes ended below/);
  assert.equal(damaged.fetches, 0);
  // Inside an offline run any fetch is refused before it leaves.
  await assert.rejects(H.withNoNetwork(() => fetch('https://besttime.app/api/v1/keys/x')), /REFUSED: an --offline run makes no request/);
});

test('--parity: every exported weekly row of the venues this folder wrote equals the generator\'s, another pass\'s venues are left out, and a changed field is caught', async () => {
  assert.ok(phillyDir, 'the --offline test runs first');
  // The harvest stamps the month at write time; these were written by this
  // test, today, and the parity fixture's answers say November. The real
  // harvest wrote November's rows in November. Likewise when: the corpus
  // rows long before the answers, the harvested ones an hour after.
  await pool.query(`UPDATE ml_training_data t SET month = 11, season = 'fall' FROM ml_venues v
                     WHERE v.id = t.venue_id AND v.besttime_status = $1`, [H.HARVEST_STATUS]);
  await pool.query(`UPDATE ml_venues SET created_at = CASE WHEN besttime_status = $1
                      THEN TIMESTAMPTZ '2026-11-24T13:00:00Z' ELSE TIMESTAMPTZ '2026-10-01T00:00:00Z' END`, [H.HARVEST_STATUS]);
  const outDir = tmp('flock-import-export-');
  const exported = await exporter.runExport({ pool: roPool, outDir, includeHarvested: true, log: () => {} });
  // The snapshot, as THE SNAPSHOT in the importer's header takes it: its
  // query and the table's count and id range in one read-only REPEATABLE
  // READ transaction, the CSV, then the meta. `createdAt` rewrites a venue's
  // created_at in the CSV, as if another writer had made its row then.
  const client = await roPool.connect();
  let rows;
  let table;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    ({ rows } = await client.query(I.SNAPSHOT_QUERY));
    ({ rows: [table] } = await client.query('SELECT COUNT(*)::int AS n, MIN(id)::int AS lo, MAX(id)::int AS hi FROM ml_venues'));
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const csv = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const snapshot = (name, { createdAt = {}, columns = 'all', meta = true } = {}) => {
    const file = path.join(outDir, name);
    const head = ['id', 'besttime_venue_id', 'google_place_id', 'name', 'latitude', 'longitude', 'city',
      ...(columns === 'all' ? ['besttime_status', 'created_at'] : [])];
    fs.writeFileSync(file, `${[head.join(','), ...rows.map((r) => head.map((h) => {
      if (h === 'created_at') return createdAt[r.besttime_venue_id] || r.created_at;
      return csv(r[h]);
    }).join(','))].join('\n')}\n`);
    if (meta) writeSnapshotMeta(file, { tableCount: table.n, tableMinId: table.lo, tableMaxId: table.hi });
    return file;
  };
  const snap = snapshot('snapshot.csv');
  // Both required: the 404s the fill met, and the next writer's start (none
  // came here; a day after the harvested rows).
  const parity = (exportCsv, { dir = phillyDir, snapFile = snap, misses = phillyNotFound, bound = '2026-11-26T00:00:00Z' } = {}) => runImport([
    '--parity', `--cache-dir=${dir}`, '--cities=philly', '--radius-km=20', `--identity-snapshot=${snapFile}`, `--export-csv=${exportCsv}`,
    `--expect-misses=${misses}`, `--written-before=${bound}`]);

  const ok = await parity(exported.trainPath);
  assert.equal(ok.result.exitCode, 0, ok.out);
  assert.equal(ok.result.venues, 2);
  const harvestedRows = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_training_data t JOIN ml_venues v ON v.id = t.venue_id WHERE v.besttime_status = $1`,
    [H.HARVEST_STATUS]
  )).rows[0].n;
  assert.equal(ok.result.rowsCompared, harvestedRows);
  assert.equal(ok.result.rowsEqual, harvestedRows);
  // The 24 corpus venues were held before the folder's first answer.
  assert.equal(ok.result.left.heldBeforeFirstAnswer, 24);
  assert.equal(ok.result.harvestedElsewhere, 0);
  // The snapshot, read alone, shows the same two writes.
  assert.deepEqual([ok.result.writes.candidates, ok.result.writes.compared, ok.result.writes.unreproduced], [2, 2, []]);

  // A whole venue's answers gone (every record of NEW2 taken out of every
  // answer, each answer's venues_n made to agree): nothing in what is left
  // shows it, and its exported rows are no compared venue's extras. The
  // snapshot shows the write, so the proof fails, naming it.
  const { rows: [written2] } = await pool.query('SELECT id FROM ml_venues WHERE besttime_venue_id = $1', [NEW2.id]);
  const withoutDir = path.join(tmp('flock-import-philly-without-'), 'philly-2026-11');
  fs.cpSync(phillyDir, withoutDir, { recursive: true });
  for (const name of fs.readdirSync(withoutDir)) {
    rewriteAnswer(path.join(withoutDir, name), (entry) => {
      entry.data.venues = entry.data.venues.filter((v) => v.venue_id !== NEW2.id);
      entry.data.venues_n = entry.data.venues.length;
    });
  }
  const without = await parity(exported.trainPath, { dir: withoutDir });
  assert.equal(without.result.exitCode, 1, without.out);
  assert.equal(without.result.venues, 1);
  assert.equal(without.result.rowsEqual, without.result.rowsCompared);
  assert.deepEqual(without.result.writes.unreproduced, [{ id: written2.id, btId: NEW2.id, why: 'inNoAnswerHere' }]);
  assert.match(without.out, new RegExp(`1 NOT REPRODUCED \\(${written2.id} ${NEW2.id} inNoAnswerHere\\)`));
  assert.match(without.out, /PARITY FAIL/);

  // A damaged record, or a miss count other than the fill's: refused.
  const damagedDir = path.join(tmp('flock-import-philly-damaged-'), 'philly-2026-11');
  fs.cpSync(phillyDir, damagedDir, { recursive: true });
  const withOne = fs.readdirSync(damagedDir).find((n) => JSON.parse(fs.readFileSync(path.join(damagedDir, n), 'utf8')).data.venues
    .some((v) => v.venue_id === NEW1.id));
  rewriteAnswer(path.join(damagedDir, withOne), (entry) => {
    const rec = entry.data.venues.find((v) => v.venue_id === NEW1.id);
    rec.day_raw_whole[5] = '40';
  });
  const damaged = await parity(exported.trainPath, { dir: damagedDir });
  assert.equal(damaged.result.exitCode, 1);
  assert.match(damaged.out, /PARITY REFUSED: the folder's answers are damaged: curve slots no number 0 to 100 1\./);
  const wrongMisses = await parity(exported.trainPath, { misses: phillyNotFound + 1 });
  assert.equal(wrongMisses.result.exitCode, 1);
  assert.match(wrongMisses.out, new RegExp(`PARITY REFUSED: ${phillyNotFound} misses, ${phillyNotFound + 1} expected`));

  // A snapshot without besttime_status and created_at cannot tell which
  // venues this folder wrote: refused.
  const bare = await parity(exported.trainPath, { snapFile: snapshot('bare.csv', { columns: 'seven', meta: false }) });
  assert.equal(bare.result.exitCode, 1);
  assert.match(bare.out, /lacks besttime_status and created_at/);
  // Nor can one without its meta show it is the whole table.
  const noMeta = await parity(exported.trainPath, { snapFile: snapshot('nometa.csv', { meta: false }) });
  assert.equal(noMeta.result.exitCode, 1);
  assert.match(noMeta.out, /PARITY REFUSED: no nometa\.meta\.json beside the snapshot/);

  const { rows: [one] } = await pool.query('SELECT id FROM ml_venues WHERE besttime_venue_id = $1', [NEW1.id]);
  const { rows: [two] } = await pool.query('SELECT id FROM ml_venues WHERE besttime_venue_id = $1', [NEW2.id]);
  const lines = fs.readFileSync(exported.trainPath, 'utf8').split('\n');
  const linesOf = (id) => lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith(`${id},`)).map(([, i]) => i);
  const writeLines = (name, ls) => { const f = path.join(outDir, name); fs.writeFileSync(f, ls.join('\n')); return f; };

  // A live reading of the same venue and slot is no weekly row: skipped.
  const live = I.parseCsv(lines[linesOf(one.id)[0]])[0];
  live[col('is_realtime')] = '1';
  live[col('label_provenance')] = 'live';
  live[col('busyness_pct')] = '99';
  const withLive = await parity(writeLines('live.csv', [...lines.slice(0, -1), live.join(','), '']));
  assert.equal(withLive.result.exitCode, 0, withLive.out);
  assert.equal(withLive.result.nonWeeklySkipped, 1);

  // One rating changed, and one row gone.
  const mine = linesOf(one.id);
  assert.ok(mine.length > 2);
  const tamperedLines = [...lines];
  const f = I.parseCsv(tamperedLines[mine[0]])[0];
  assert.equal(f[col('rating')], '4.4');
  f[col('rating')] = '4.3';
  tamperedLines[mine[0]] = f.join(',');
  tamperedLines.splice(mine[1], 1);
  const bad = await parity(writeLines('tampered.csv', tamperedLines));
  assert.equal(bad.result.exitCode, 1);
  assert.equal(bad.result.mismatches.rating, 1);
  assert.equal(Object.values(bad.result.mismatches).reduce((a, b) => a + b, 0), 1);
  assert.equal(bad.result.missing, 1);
  assert.match(bad.out, /PARITY FAIL/);

  // A correct weekly row held twice: every column of both equals the
  // generator's, and it is still a mismatch.
  const twice = [...lines];
  twice.splice(mine[0] + 1, 0, lines[mine[0]]);
  const dup = await parity(writeLines('duplicate.csv', twice));
  assert.equal(dup.result.exitCode, 1, dup.out);
  assert.equal(dup.result.mismatches.duplicateExportRow, 1);
  assert.deepEqual([dup.result.rowsEqual, dup.result.missing, dup.result.extra], [dup.result.rowsCompared, 0, 0]);
  assert.match(dup.out, /duplicateExportRow 1/);
  assert.match(dup.out, /PARITY FAIL/);

  // Another pass wrote NEW2, from its own answers (another review count),
  // before this folder's first answer: left out, never a mismatch.
  const otherPass = [...lines];
  for (const i of linesOf(two.id)) {
    const g = I.parseCsv(otherPass[i])[0];
    g[col('review_count')] = '7';
    otherPass[i] = g.join(',');
  }
  const otherPassCsv = writeLines('other_pass.csv', otherPass);
  assert.equal((await parity(otherPassCsv)).result.exitCode, 1, 'compared as this folder\'s, NEW2 must fail');
  const early = await parity(otherPassCsv, { snapFile: snapshot('early.csv', { createdAt: { [NEW2.id]: '2026-11-20T00:00:00.000Z' } }) });
  assert.equal(early.result.exitCode, 0, early.out);
  assert.equal(early.result.venues, 1);
  assert.deepEqual([early.result.left.heldBeforeFirstAnswer, early.result.harvestedElsewhere], [25, 1]);

  // Or a later writer (the next pass, a venue search) wrote NEW2 after
  // every answer here, as London's 40 km pass did: created_at alone takes it
  // for this folder's, and --written-before, the next writer's start, does
  // not. A row created at the bound itself is the later writer's.
  const laterSnap = snapshot('later.csv', { createdAt: { [NEW2.id]: '2026-11-25T00:00:00.000000Z' } });
  assert.equal((await parity(otherPassCsv, { snapFile: laterSnap })).result.exitCode, 1, 'with a bound after it NEW2 is compared');
  for (const bound of ['2026-11-24T18:00:00Z', '2026-11-25T00:00:00Z']) {
    const later = await parity(otherPassCsv, { snapFile: laterSnap, bound });
    assert.equal(later.result.exitCode, 0, later.out);
    assert.equal(later.result.venues, 1);
    assert.deepEqual([later.result.left.writtenByALaterWriter, later.result.harvestedElsewhere], [1, 1]);
    assert.match(later.out, /writtenByALaterWriter 1/);
  }
  // Before the folder's own writes, the bound leaves nothing to compare.
  const tooEarly = await parity(exported.trainPath, { bound: '2026-11-24T12:30:00Z' });
  assert.equal(tooEarly.result.exitCode, 1);
  assert.equal(tooEarly.result.left.writtenByALaterWriter, 2);

  // Or after the folder's first answer but before its answers for NEW2 here
  // (fetched at 14:00; NEW2's row is from 13:00, NEW1's from 15:00).
  const laterDir = path.join(tmp('flock-import-philly-later-'), 'philly-2026-11');
  fs.cpSync(phillyDir, laterDir, { recursive: true });
  for (const name of fs.readdirSync(laterDir)) {
    rewriteAnswer(path.join(laterDir, name), (entry) => {
      if (entry.data.venues.some((v) => v.venue_id === NEW2.id)) entry.fetchedAt = '2026-11-24T14:00:00.000Z';
    });
  }
  const mid = await parity(otherPassCsv, {
    dir: laterDir, snapFile: snapshot('mid.csv', { createdAt: { [NEW1.id]: '2026-11-24T15:00:00.000Z' } }),
  });
  assert.equal(mid.result.exitCode, 0, mid.out);
  assert.equal(mid.result.venues, 1);
  assert.deepEqual([mid.result.left.writtenBeforeItsAnswerHere, mid.result.harvestedElsewhere], [1, 1]);
  // The snapshot shows NEW2's write in the window, and the replay found it,
  // written before an answer here that lists it: left out, justified.
  assert.deepEqual([mid.result.writes.candidates, mid.result.writes.compared, mid.result.writes.justified,
    mid.result.writes.unreproduced.length], [2, 1, 1, 0]);

  // A verified report for NEW1, a day before its rows were collected: the
  // exporter joins it into the feedback columns of every row of NEW1, and the
  // generator's 0, 0, 0 no longer match. (Which is why --write needs the
  // feedback snapshot to show no kept venue has one.)
  const { rows: [tz] } = await pool.query('SELECT timezone FROM ml_venues WHERE id = $1', [one.id]);
  await pool.query(
    `INSERT INTO venue_feedback (venue_place_id, venue_name, crowd_level, predicted_score, day_of_week, hour, verified, created_at)
     SELECT $1, 'Offline One', 3, 40, EXTRACT(DOW FROM (x.at AT TIME ZONE $2))::int, EXTRACT(HOUR FROM (x.at AT TIME ZONE $2))::int,
            true, x.at
       FROM (SELECT (SELECT MIN(collected_at) FROM ml_training_data WHERE venue_id = $3) - INTERVAL '1 day' AS at) x`,
    [NEW1.placeId, tz.timezone || 'UTC', one.id]
  );
  try {
    const withReport = await exporter.runExport({ pool: roPool, outDir: tmp('flock-import-export-fb-'), includeHarvested: true, log: () => {} });
    const fed = await parity(withReport.trainPath);
    assert.equal(fed.result.exitCode, 1, fed.out);
    // Every weekly row of NEW1 carries the report, and nothing else moved.
    assert.equal(fed.result.mismatches.user_feedback_count, mine.length, JSON.stringify(fed.result.mismatches));
    assert.equal(fed.result.mismatches.user_feedback_count, fed.result.mismatches.avg_user_crowd);
    assert.equal(fed.result.mismatches.user_feedback_count, fed.result.mismatches.avg_prediction_error);
    assert.match(fed.out, /user_feedback_count export "1", generated "0"/);
  } finally {
    await pool.query('DELETE FROM venue_feedback WHERE venue_place_id = $1', [NEW1.placeId]);
  }
});
