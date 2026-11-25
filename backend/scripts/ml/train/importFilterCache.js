'use strict';
// ---------------------------------------------------------------------------
// THE NOVEMBER FILTER CACHE AS TRAINING ROWS, OFFLINE (the CSV route)
// ---------------------------------------------------------------------------
// Run (from backend/):
//   node scripts/ml/train/importFilterCache.js --dry-run
//        --cache-root=<the cache's filter-cache folder> --plan=<its tools/cities_1123.json>
//        [--harvest-cache=<its harvest-cache folder>]        the training cities' peak hours
//        [--identity-snapshot=<ml_venues.csv>]                identity rules and the 2 km rule
//        [--export-dir=<the harvest-inclusive export's folder>] checked against the snapshot
//        [--report-json=<file>] [--only=<key,...>]
//   node scripts/ml/train/importFilterCache.js --write --out-dir=<dir> (the same inputs; the
//        snapshot, --export-dir and --harvest-cache are required) [--accept-peak-flags=<key,...>]
//   node scripts/ml/train/importFilterCache.js --parity --cache-dir=<one harvest-cache run folder>
//        --cities=<the run's --city keys> --radius-km=<its radius> --identity-snapshot=<csv>
//        --export-csv=<the harvest-inclusive training_data.csv> [--expect-misses=<n>]
//
// THE SNAPSHOT (plan step C.4), one read-only query, as CSV with a header:
//   SELECT id, besttime_venue_id, google_place_id, name, latitude, longitude, city, besttime_status,
//          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
//     FROM ml_venues ORDER BY id
// The import reads the first seven columns; --parity needs the last two as
// well and refuses a snapshot without them. Take it after the
// harvest-inclusive export has finished: --write refuses a snapshot that
// lacks any venue the export holds.
//
// MEMORY. A full dry run over the 185 folders holds every city's venues until
// the global pass, then about 330k kept weeks of 168 bytes each. Measured
// 2026-11-25 with --harvest-cache, under Node 25's default 4,288 MB heap:
// 143 s, peak resident 1,890 MB, 371 MB of heap at the end. The first version
// kept 168 cell objects per venue and ran out of that heap; if a run ever does
// again, `node --max-old-space-size=12288` is the stopgap, never a smaller
// cache.
//
// WHAT THIS IS. BestTime's subscription ended on 2026-11-25. Before it did, a
// read-only cacher (tools/cacheEverything.cjs, kept beside the cache, outside
// this repository) asked the Venue Filter the harvest's own questions for the
// cities in cities_1123.json and kept every answer on disk, one folder per
// city, in THE CACHE's format (harvestVenueFilter.js), with progress.json
// recording each city's state and 404 count. Nothing can be fetched again. This script turns those answers into rows of the exact shape
// export_training_data.js writes (HEADER, rowToCsv), for appending to a
// harvest-inclusive export's training_data.csv. It never opens a database
// connection and never reaches the network (harvestVenueFilter.withNoNetwork
// refuses every fetch while it runs): the production database is not where
// these rows go. The decision and its costs are in the import plan (the CSV
// route, steps C.1 to C.7); the rules below are that plan's, checked here.
//
// EACH CITY IS REPLAYED ALONE, EXACTLY AS THE CACHER ASKED. harvestVenueFilter
// is driven with --offline semantics (harvestBox, harvestDay, fetchTile,
// mergeDay, checkMarketDays, the same functions a harvest runs) around the
// plan's own lat/lon and radiusKm, with the cacher's settings (CACHER below:
// 20 km tiles, 100 a page, the 500 cap, all seven days, the 40 mapped types,
// place ids asked). A question the city's folder has no answer for is an empty
// box, as a 404 was, and a city is REFUSED unless:
//   * the plan entry is not config:true, and its key is no config.js city
//     (the holdout and beijing folders are never opened);
//   * progress.json says the cacher finished it (state 'done') around the same
//     centroid and radius, from the folder the plan names;
//   * every answer file in its folder answered a question of the replay;
//   * the replay's misses equal progress.json's notFound (the cacher never
//     kept a 404, so only that many questions may lack an answer: Macau, cut
//     by the 402 with 17 questions unasked, is refused here);
//   * no record named a day other than the one asked, and no weekday's
//     records all left the day out (checkMarketDays): refused as dayCheck;
//   * the replay ran to its end (an answer with no venue list stops it):
//     refused as replayAbort, with the harvester's message;
//   * no record was malformed (no venue id, or no 24-hour curve) and no box
//     reached the 500 cap at the smallest tile (venues there were never
//     listed): the counts are printed for every city, accepted or not;
//   * the month is the same in every time zone at every fetchedAt.
//
// ONE GLOBAL PASS, so a venue inside two cities' circles is one venue. Every
// venue is placed with harvestVenueFilter.placeVenue (the PA rule first, then
// the nearest centroid within MAX_KM) among every training city, the refused
// four (the holdouts and beijing) and every cache city, accepted or not. A
// venue placed in a training city, a holdout, beijing or a refused cache city
// is dropped, by name, and so is one within MAX_KM of a holdout's or
// beijing's centroid wherever it was placed (the plan's rule reads "nearest
// centroid within 80 km"; a cache city near a holdout would otherwise keep
// the venues between them). The rest go through harvestVenueFilter.planVenues:
// with --identity-snapshot its identity rules 1 to 4 against ml_venues (a
// venue the corpus already holds, by BestTime id, by Google place id or as a
// near-duplicate, is dropped: the corpus has it), then the radius, the type
// map, the name, the signal and the twin rule, as a harvest's new venues. The
// radius is every accepted circle's: a venue inside any accepted city's
// circle passes, placed in its nearest city, even when that city's own
// circle is smaller and does not reach it (814 venues of the November cache,
// placed in eight smaller neighbours, 299 of them San Francisco's nearer San
// Jose). With the snapshot, a venue within CORPUS_KEEP_AWAY_KM of any
// ml_venues row, or of any venue the export holds (--export-dir), is dropped
// too: these rows never reach serving, so a cache venue must never sit in a
// corpus venue's neighbour box (+-0.0075 degrees, corners about 1.2 km away).
// Without the snapshot both rules are reported as pending, never as passed,
// and --write refuses.
//
// THE EXPORT (--export-dir, the folder holding the harvest-inclusive
// training_data.csv and holdout_data.csv these rows are appended to). The
// identity rules and the 2 km rule are only as good as the snapshot, and
// nothing in a CSV says it is the whole of ml_venues, current, from the right
// database. So every venue id either export file holds must be a snapshot
// row (a WHERE clause, a truncated copy or a snapshot older than the export
// is refused), neither file may hold a cache row already (an id from
// SYNTHETIC_ID_BASE, or city world_cache), and the 2 km rule also reads the
// export's own coordinates, which are what the neighbour box is built from.
// Both files' SHA-256s go into the manifest.
//
// THE ROWS (rowToCsv, given a row shaped as the export's query returns one,
// so the format cannot drift from it): one per held cell of the venue's week
// (weekCells), in venue, day, hour order; city 'world_cache' on every row (one
// more leave-one-city-out fold, sorted after every training city), the real
// city key in the sidecar; venue ids SYNTHETIC_ID_BASE + n; month from the
// answers' fetchedAt and its season (config.getSeason), as upsertWeek would
// have stamped at write time; baseline_busyness the venue's own value (the
// export's BASELINE_AGGREGATE_SQL over a slot holding one weekly row); empty
// google_types and price as the harvester writes them; rating as NUMERIC(2,1)
// stores it; events_observed false; is_holiday and is_school_break 0 (column
// defaults); user feedback 0,0,0 (COALESCE over no reports).
//
// THE PEAK-HOUR CHECK (in place of the commit gate, which needs 20 known
// venues and 179 of these cities have none). harvestVenueFilter's
// peakHourHistogram per category for each city, against the training cities'
// (every harvest-cache answer placed in a training city, by the same per-venue
// peak). A city whose bar or nightclub mode moves PEAK_SHIFT_FLAG_HOURS or more
// (on the 24-hour circle) is FLAGGED. --write refuses a flagged city unless
// --accept-peak-flags names it; the dry run says which and how far.
//
// --parity (plan step C.5): one harvest-cache run folder replayed with the
// harvest's own tiling (config.js centroids, its cities and radius), and the
// venues THIS FOLDER'S RUNS WROTE emitted under their stored ids and cities
// by the same row builder and compared field by field, city aside, with those
// venues' weekly rows in the export (is_realtime 0, label_provenance weekly;
// a live row of the same venue is skipped and counted). Every November
// harvest ran --new-only, so a venue's rows were written once, by the pass
// that inserted it, from that pass's answers: the 20 km and 40 km passes
// answered the same venue with different review counts and ratings on 3,557
// of 22,975 venue-days in austin alone, so comparing a venue another pass
// wrote would fail a correct generator. Which venues this folder wrote is
// read from the snapshot's created_at: the replay is planned against the
// corpus as it stood before the folder's first answer (rows created before
// that fetchedAt, and rows with no created_at), and a venue is compared when
// that plan calls it new, its row is 'harvested', and the row was created
// after every answer of this folder that lists the venue. The rest are
// counted apart, by why, never as mismatches. Exit 0 only when every compared
// row matches and neither side has a weekly row the other lacks. What
// created_at cannot show: a row another writer (the other pass, a venue
// search) created after this folder's last answer for the venue and before
// this folder's own commit. The November passes ran one city at a time, 20 km
// then 40 km, so prove parity on a folder no other writer overlapped.
//
// OUTPUTS (--write; each refused if it exists): cache_rows.csv (HEADER, then
// the rows; append it to training_data.csv without its first line),
// cache_venues.csv (synthetic id -> city key, BestTime and Google ids, name,
// position, category, days, rows) and cache_manifest.json (inputs, the
// export's files included, and outputs with SHA-256s, the git commit, every
// count).
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const H = require('../harvestVenueFilter');
const { CITIES, getSeason } = require('../config');
const { PA_CITIES, MAX_KM, kmBetween } = require('../addDemandVenues');
const { HEADER, rowToCsv, HOLDOUT_CITIES } = require('./export_training_data');

const TAG = '[ML:ImportCache]';

// The CSV's city on every cache row (see the header).
const WORLD_CACHE_CITY = 'world_cache';
// Synthetic ml_venues ids: far above any real one, inside int32.
const SYNTHETIC_ID_BASE = 1000000000;
const INT32_MAX = 2147483647;
const CORPUS_KEEP_AWAY_KM = 2;
const PEAK_SHIFT_FLAG_HOURS = 3;
const PEAK_FLAG_CATEGORIES = ['bar', 'nightclub'];
// Reported beside a flag, never a reason to drop one.
const PEAK_FEW_VENUES = 10;
// cacheEverything.cjs's settings, spelled out rather than read from the
// harvester's defaults: the replay must ask what the cacher asked even if a
// default there ever moves.
const CACHER = Object.freeze({
  tileKm: 20, pageSize: 100, resultCap: 500, days: Object.freeze([0, 1, 2, 3, 4, 5, 6]), allTypes: false, askPlaceId: true,
});
const CACHE_FILE_RE = /^[0-9a-f]{64}\.json$/;
// UTC offsets in use span -12 h to +14 h.
const UTC_OFFSET_MIN_MS = -12 * 3600 * 1000;
const UTC_OFFSET_MAX_MS = 14 * 3600 * 1000;
const SNAPSHOT_COLUMNS = ['id', 'besttime_venue_id', 'google_place_id', 'name', 'latitude', 'longitude', 'city'];
// What --parity needs besides: which venues a harvest wrote, and when.
const PARITY_SNAPSHOT_COLUMNS = ['besttime_status', 'created_at'];
const HEADER_FIELDS = HEADER.split(',');
const CITY_COLUMN = HEADER_FIELDS.indexOf('city');
const EXPORT_COLUMNS = Object.freeze({
  latitude: HEADER_FIELDS.indexOf('latitude'),
  longitude: HEADER_FIELDS.indexOf('longitude'),
  isRealtime: HEADER_FIELDS.indexOf('is_realtime'),
  labelProvenance: HEADER_FIELDS.indexOf('label_provenance'),
});
// The harvest-inclusive export's two files (export_training_data.runExport).
const EXPORT_FILES = Object.freeze(['training_data.csv', 'holdout_data.csv']);
const OUTPUT_FILES = Object.freeze({ rows: 'cache_rows.csv', venues: 'cache_venues.csv', manifest: 'cache_manifest.json' });
// A kept venue's week: day_of_week * 24 + hour, ABSENT where it holds no cell.
const WEEK_SLOTS = 168;
const ABSENT = 255;
// The holdout cities and beijing: no kept venue within MAX_KM of one.
const FAR_FROM = Object.freeze([...HOLDOUT_CITIES, 'beijing'].map((key) => Object.freeze({ key, lat: CITIES[key].lat, lon: CITIES[key].lon })));

// Drop reasons this script adds to planVenues' own (its `skipped` keys).
const IDENTITY_DROPS = { known_bt: 'knownByBesttimeId', known_place: 'knownByPlaceId', known_near: 'knownNearDuplicate' };
const KEEP_AWAY_DROP = 'within2kmOfCorpusVenue';
const NEAR_HOLDOUT_DROP = `within${MAX_KM}kmOfHoldoutOrBeijing`;

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------
function parseImportArgs(argv) {
  const args = argv.slice(2);
  const flags = ['--dry-run', '--write', '--parity'];
  const valued = ['--cache-root=', '--plan=', '--progress=', '--harvest-cache=', '--identity-snapshot=', '--report-json=',
    '--out-dir=', '--accept-peak-flags=', '--only=', '--cache-dir=', '--cities=', '--radius-km=', '--export-csv=',
    '--expect-misses=', '--export-dir='];
  for (const a of args) {
    if (!flags.includes(a) && !valued.some((p) => a.startsWith(p))) return { error: `Unknown argument "${a}".` };
  }
  const modes = flags.filter((f) => args.includes(f));
  if (modes.length !== 1) return { error: 'Name exactly one of --dry-run, --write and --parity.' };
  const mode = modes[0].slice(2);
  const val = (name) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    if (a === undefined) return null;
    const v = a.slice(name.length + 3).trim();
    return v === '' ? '' : v;
  };
  const filePath = (name) => (val(name) ? path.resolve(val(name)) : null);
  const list = (name) => (val(name) ? [...new Set(val(name).split(',').map((s) => s.trim()).filter(Boolean))] : []);
  for (const name of ['cache-root', 'plan', 'progress', 'harvest-cache', 'identity-snapshot', 'report-json', 'out-dir',
    'cache-dir', 'export-csv', 'export-dir']) {
    if (val(name) === '') return { error: `--${name} takes a path.` };
  }
  const opts = {
    mode,
    cacheRoot: filePath('cache-root'),
    plan: filePath('plan'),
    progress: filePath('progress'),
    harvestCache: filePath('harvest-cache'),
    identitySnapshot: filePath('identity-snapshot'),
    reportJson: filePath('report-json'),
    outDir: filePath('out-dir'),
    acceptPeakFlags: list('accept-peak-flags'),
    only: list('only'),
    cacheDir: filePath('cache-dir'),
    cities: list('cities'),
    radiusKm: null,
    exportCsv: filePath('export-csv'),
    expectMisses: null,
    exportDir: filePath('export-dir'),
  };
  if (mode === 'parity') {
    for (const [name, v] of [['cache-dir', opts.cacheDir], ['identity-snapshot', opts.identitySnapshot],
      ['export-csv', opts.exportCsv]]) {
      if (!v) return { error: `--parity needs --${name}.` };
    }
    // A harvest-cache run folder names its run (runFolderScope); what is
    // given must agree with it, and what is not given is read from it.
    const named = runFolderScope(path.basename(opts.cacheDir));
    if (opts.cities.length === 0 && named) opts.cities = named.cities;
    if (opts.cities.length === 0) return { error: '--parity needs --cities, the --city keys of the run that filled --cache-dir.' };
    const bad = opts.cities.find((c) => !H.CENTROIDS[c] || H.REFUSED_CITIES[c]);
    if (bad) return { error: `--cities takes training-city keys of config.js; got "${bad}".` };
    const r = val('radius-km') || (named ? String(named.radiusKm) : null);
    if (!r || !/^\d+$/.test(r) || Number(r) < 1 || Number(r) > MAX_KM) {
      return { error: `--parity needs --radius-km, the run's radius (1 to ${MAX_KM}).` };
    }
    opts.radiusKm = Number(r);
    if (named && (named.cities.join(',') !== opts.cities.join(',') || named.radiusKm !== opts.radiusKm)) {
      return {
        error: `${path.basename(opts.cacheDir)} names the run --city=${named.cities.join(',')} --radius-km=${named.radiusKm}; `
          + `--cities=${opts.cities.join(',')} --radius-km=${opts.radiusKm} would ask other questions.`,
      };
    }
    const m = val('expect-misses');
    if (m !== null) {
      if (!/^\d+$/.test(m)) return { error: '--expect-misses takes a whole number.' };
      opts.expectMisses = Number(m);
    }
    for (const name of ['cache-root', 'plan', 'progress', 'harvest-cache', 'out-dir', 'accept-peak-flags', 'only', 'export-dir']) {
      if (val(name) !== null) return { error: `--${name} belongs to --dry-run and --write, not --parity.` };
    }
    return opts;
  }
  for (const name of ['cache-dir', 'cities', 'radius-km', 'export-csv', 'expect-misses']) {
    if (val(name) !== null) return { error: `--${name} belongs to --parity.` };
  }
  if (!opts.cacheRoot || !opts.plan) return { error: `--${mode} needs --cache-root and --plan.` };
  if (!opts.progress) opts.progress = path.join(opts.cacheRoot, 'progress.json');
  if (opts.exportDir && !opts.identitySnapshot) {
    return { error: '--export-dir is checked against --identity-snapshot; name both.' };
  }
  if (mode === 'write') {
    if (!opts.outDir) return { error: '--write needs --out-dir.' };
    if (!opts.identitySnapshot) {
      return { error: '--write needs --identity-snapshot: the identity rules and the 2 km rule are not optional for rows that train.' };
    }
    if (!opts.exportDir) {
      return { error: '--write needs --export-dir: the export these rows join is what proves the snapshot is whole and current.' };
    }
    if (!opts.harvestCache) return { error: '--write needs --harvest-cache: the peak-hour check stands in for the commit gate.' };
    if (opts.only.length) return { error: '--only is for a look at a few cities; --write takes every city or none.' };
  } else {
    if (opts.outDir) return { error: '--out-dir belongs to --write.' };
    if (opts.acceptPeakFlags.length) return { error: '--accept-peak-flags belongs to --write.' };
  }
  return opts;
}

// A harvest-cache run folder's name is its run: the --city keys in the order
// asked, joined by "," or "+", the month, and "-r<km>" when the radius was not
// the default ("nyc-2026-11-r40", "denver,seattle,chicago,la-2026-11"). Null
// when the name is not one of these.
function runFolderScope(name) {
  const m = /^([a-z0-9]+(?:[,+][a-z0-9]+)*)-\d{4}-\d{2}(?:-r(\d+))?$/.exec(name);
  if (!m) return null;
  return { cities: m[1].split(/[,+]/), radiusKm: m[2] ? Number(m[2]) : H.DEFAULT_RADIUS_KM };
}

// ---------------------------------------------------------------------------
// Inputs: the plan, the cacher's progress and its folders.
// ---------------------------------------------------------------------------
function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// cities_1123.json, read as cacheEverything.cjs reads it. A config:true entry
// keeps no centroid of its own here: it is refused, never replayed.
function loadPlan(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${file}: the plan is not a list`);
  const seen = new Set();
  return raw.map((c) => {
    if (!c || typeof c.key !== 'string' || !/^[a-z0-9]+$/.test(c.key)) throw new Error(`plan: bad key ${JSON.stringify(c && c.key)}`);
    if (seen.has(c.key)) throw new Error(`plan: ${c.key} twice`);
    seen.add(c.key);
    const config = Boolean(c.config);
    const radiusKm = Number(c.radiusKm);
    if (!Number.isInteger(radiusKm) || radiusKm < 5 || radiusKm > 60) throw new Error(`plan: ${c.key} radius ${c.radiusKm}`);
    const lat = Number(c.lat);
    const lon = Number(c.lon);
    if (!config && (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180)) {
      throw new Error(`plan: ${c.key} has no usable centroid`);
    }
    return { key: c.key, name: c.name || c.key, lat: config ? null : lat, lon: config ? null : lon, radiusKm, config };
  });
}

function loadProgress(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw.cities !== 'object' || raw.cities === null) throw new Error(`${file}: no "cities" object`);
  return raw;
}

const refuse = (city, reason, detail) => city.refused.push({ reason, detail });

// Every plan entry, judged before a file is opened. `cacheCities` are the
// entries the cacher reached (a progress record), the only ones that are
// markets in the global pass; `replay` those whose folder is read.
function classifyCities(plan, progress, cacheRoot, { only = [] } = {}) {
  const folders = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const all = [];
  for (const entry of plan) {
    const p = progress.cities[entry.key] || null;
    const city = {
      ...entry, progress: p, dir: null, refused: [], replay: null, opened: false,
      notFound: p && Number.isInteger(p.notFound) ? p.notFound : null,
    };
    all.push(city);
    if (entry.config) {
      refuse(city, 'configCity', 'config:true in the plan: a config.js city (a holdout, beijing or a training city), never imported');
      continue;
    }
    if (H.REFUSED_CITIES[entry.key]) { refuse(city, 'refusedCity', H.REFUSED_CITIES[entry.key]); continue; }
    if (H.CENTROIDS[entry.key]) {
      refuse(city, 'trainingCityKey', 'the key is a config.js city; its rows are the harvest\'s, not this import\'s');
      continue;
    }
    if (!p) { city.unreached = true; continue; }
    const want = new RegExp(`^${entry.key}-\\d{4}-\\d{2}-r${entry.radiusKm}$`);
    if (typeof p.dir !== 'string' || !want.test(p.dir)) {
      refuse(city, 'progressDisagrees', `progress.json names folder ${JSON.stringify(p.dir)}, not ${entry.key}-YYYY-MM-r${entry.radiusKm}`);
    } else if (!folders.includes(p.dir)) {
      refuse(city, 'noFolder', `${p.dir} is not in ${cacheRoot}`);
    } else {
      city.dir = path.join(cacheRoot, p.dir);
    }
    if (p.lat !== entry.lat || p.lon !== entry.lon || p.radiusKm !== entry.radiusKm || Boolean(p.config)) {
      refuse(city, 'progressDisagrees', `progress.json cached it around ${p.lat},${p.lon} r${p.radiusKm}`
        + `${p.config ? ' as a config city' : ''}; the plan says ${entry.lat},${entry.lon} r${entry.radiusKm}`);
    }
    if (p.state !== 'done') refuse(city, 'cacherNotDone', `progress.json state "${p.state}": the cacher did not finish it`);
    if (city.notFound === null) refuse(city, 'noNotFoundCount', 'progress.json records no notFound count to check misses against');
  }
  const byDir = new Set(all.map((c) => c.dir && path.basename(c.dir)).filter(Boolean));
  const foldersNotRead = folders.filter((f) => !byDir.has(f)).sort();
  const cacheCities = all.filter((c) => !c.config && !H.CENTROIDS[c.key] && c.progress);
  const wanted = only.length ? new Set(only) : null;
  const unknownOnly = only.filter((k) => !cacheCities.some((c) => c.key === k));
  if (unknownOnly.length) throw new Error(`--only names cities the cache does not hold: ${unknownOnly.join(', ')}`);
  const replay = cacheCities.filter((c) => c.dir && (!wanted || wanted.has(c.key)));
  return { all, cacheCities, replay, foldersNotRead };
}

// ---------------------------------------------------------------------------
// The replay of one city (see the header).
// ---------------------------------------------------------------------------
const listCacheFiles = (dir) => fs.readdirSync(dir).filter((f) => CACHE_FILE_RE.test(f));

// The calendar month every zone was in at every instant from minMs to maxMs,
// or null when they span two.
function monthAcrossZones(minMs, maxMs) {
  const lo = new Date(minMs + UTC_OFFSET_MIN_MS);
  const hi = new Date(maxMs + UTC_OFFSET_MAX_MS);
  if (lo.getUTCFullYear() !== hi.getUTCFullYear() || lo.getUTCMonth() !== hi.getUTCMonth()) return null;
  return lo.getUTCMonth() + 1;
}

function replayOptions({ dir, cities, radiusKm, days = CACHER.days, tileKm = CACHER.tileKm }) {
  return {
    cacheDir: dir, offline: true, expectMisses: null, commit: false, newOnly: false, dayOverVoters: false,
    cities, days: [...days], tileKm, radiusKm,
    resultCap: CACHER.resultCap, pageSize: CACHER.pageSize, allTypes: CACHER.allTypes, askPlaceId: CACHER.askPlaceId,
    maxRequests: Infinity, resultBudget: Infinity,
  };
}

// Replays `cities` (one, for the import; a harvest run's, for --parity) from
// `dir` through the harvester's own functions. `centroids` overrides
// CENTROIDS (the import's plan centroid), null for config.js's own. Returns
// the merged venues and what the folder answered; an abort the harvester
// throws is returned as `abort` (its message) and `abortDayCheck` (true for a
// record naming another day or a weekday that named none), not thrown. With
// `venueAnswered`, also the latest fetchedAt (ms) of an answer listing each
// venue, by BestTime id (--parity).
async function replayFolder({ dir, cities, radiusKm, centroids = null, venueAnswered = false }) {
  const opts = replayOptions({ dir, cities, radiusKm });
  const tilePlan = centroids
    ? H.planTiles(cities, opts.tileKm, radiusKm, centroids)
    : H.planTiles(cities, opts.tileKm, radiusKm);
  const held = listCacheFiles(dir);
  const stray = fs.readdirSync(dir).filter((f) => !CACHE_FILE_RE.test(f));
  const read = new Set();
  const fetched = { min: Infinity, max: -Infinity, bad: 0 };
  const answered = venueAnswered ? new Map() : null;
  const ctx = {
    key: H.OFFLINE_KEY, opts, stats: H.emptyStats(), sleep: async () => {}, pace: async () => {},
    city: H.emptyCityStats(tilePlan.length), area: null, dayTally: new Map(), otherDays: new Map(), secrets: [],
    centroids: centroids || undefined, quiet: true,
    onCacheHit: (keyless, entry) => {
      read.add(H.cacheFileName(keyless));
      const at = Date.parse(entry.fetchedAt);
      if (!Number.isFinite(at)) { fetched.bad++; return; }
      fetched.min = Math.min(fetched.min, at);
      fetched.max = Math.max(fetched.max, at);
      if (answered && Array.isArray(entry.data.venues)) {
        for (const raw of entry.data.venues) {
          const id = raw && typeof raw.venue_id === 'string' ? raw.venue_id.trim() : '';
          if (id && !(answered.get(id) >= at)) answered.set(id, at);
        }
      }
    },
  };
  const venues = new Map();
  let abort = null;
  let abortDayCheck = false;
  try {
    for (const { area, tile } of tilePlan) {
      ctx.area = area;
      await H.harvestBox(ctx, tile, venues);
    }
    for (const key of cities) H.checkMarketDays(ctx, key);
  } catch (err) {
    if (!err || !err.abort) throw err;
    abort = err.message;
    abortDayCheck = err.dayCheck === true;
  }
  const s = ctx.stats;
  const heldSet = new Set(held);
  return {
    venues,
    tiles: tilePlan.length,
    leaves: ctx.city.leaves,
    filesHeld: held.length,
    filesRead: read.size,
    filesUnread: held.filter((f) => !read.has(f)),
    readNotHeld: [...read].filter((f) => !heldSet.has(f)).length,
    strayFiles: stray.length,
    misses: s.cacheMisses,
    pages: s.cachedPages,
    results: s.cachedResults,
    splits: s.splits,
    truncatedTiles: s.truncatedTiles,
    malformed: s.malformed,
    unverifiable: s.unverifiable,
    venuesFound: [...venues.values()].filter((v) => v.days.size > 0).length,
    fetchedAt: {
      min: Number.isFinite(fetched.min) ? new Date(fetched.min).toISOString() : null,
      max: Number.isFinite(fetched.max) ? new Date(fetched.max).toISOString() : null,
      unreadable: fetched.bad,
    },
    month: Number.isFinite(fetched.min) && fetched.bad === 0 ? monthAcrossZones(fetched.min, fetched.max) : null,
    venueAnswered: answered,
    abort,
    abortDayCheck,
  };
}

// What the import reads of a merged venue (planVenues, the rows, the
// sidecar), without the address, the alternate curves or the answered days.
function slimVenue(v) {
  return {
    venueId: v.venueId, name: v.name, placeId: v.placeId, rawPlaceId: v.rawPlaceId, lat: v.lat, lng: v.lng, type: v.type,
    rating: v.rating, reviews: v.reviews, days: v.days,
  };
}

async function replayCity(city) {
  city.opened = true;
  const centroids = Object.freeze({ [city.key]: Object.freeze({ lat: city.lat, lon: city.lon }) });
  const r = await replayFolder({ dir: city.dir, cities: [city.key], radiusKm: city.radiusKm, centroids });
  city.replay = r;
  if (r.abort) refuse(city, r.abortDayCheck ? 'dayCheck' : 'replayAbort', r.abort);
  if (r.filesUnread.length > 0) {
    refuse(city, 'unusedFiles', `${r.filesUnread.length} of ${r.filesHeld} answer files answered no question of the replay `
      + `(first: ${r.filesUnread.slice(0, 3).join(', ')})`);
  }
  // No notFound in progress.json is refused here too, not only when the
  // cities are classified: nothing a miss could be checked against.
  if (r.misses !== city.notFound) {
    refuse(city, 'missesNotNotFound', `${r.misses} questions have no answer file, and progress.json recorded `
      + `${city.notFound === null ? 'no' : city.notFound} 404s: a miss that was not a 404 is a box whose venues would be lost`);
  }
  if (r.malformed > 0) {
    refuse(city, 'malformedRecords', `${r.malformed} records had no venue id or no 24-hour curve: what else the answer `
      + 'left out cannot be told from the file');
  }
  if (r.truncatedTiles > 0) {
    refuse(city, 'truncatedTiles', `${r.truncatedTiles} boxes reached the ${CACHER.resultCap} cap at the smallest tile: `
      + 'venues there were never listed');
  }
  if (r.month === null) {
    refuse(city, 'monthUnknown', `the answers' fetchedAt (${r.fetchedAt.min} to ${r.fetchedAt.max}, ${r.fetchedAt.unreadable} `
      + 'unreadable) does not fix one month in every time zone, and no zone is known');
  }
  // A refused city's venues are never read again; an accepted one's are held,
  // slimmed, until the global pass.
  if (city.refused.length > 0) {
    r.venues = null;
  } else {
    for (const [id, v] of r.venues) r.venues.set(id, slimVenue(v));
  }
  return r;
}

// ---------------------------------------------------------------------------
// The identity snapshot (plan step C.4): ml_venues, read-only, as CSV.
// ---------------------------------------------------------------------------

// RFC 4180: fields split on commas, a quoted field may hold commas, doubled
// quotes and line breaks. CRLF or LF between records.
function parseCsv(text) {
  const records = [];
  let record = [];
  let i = 0;
  const n = text.length;
  if (n === 0) return records;
  for (;;) {
    let field;
    if (text[i] === '"') {
      let j = i + 1;
      let out = '';
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) throw new Error(`CSV: a quoted field opened at character ${i} never closes`);
        out += text.slice(j, q);
        if (text[q + 1] === '"') { out += '"'; j = q + 2; continue; }
        i = q + 1;
        break;
      }
      field = out;
    } else {
      let j = i;
      while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j++;
      field = text.slice(i, j);
      if (field.includes('"')) throw new Error(`CSV: a quote inside an unquoted field at character ${i}`);
      i = j;
    }
    record.push(field);
    if (i >= n) { records.push(record); break; }
    if (text[i] === ',') { i++; continue; }
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    else if (i < n) throw new Error(`CSV: unexpected character after a field at ${i}`);
    records.push(record);
    record = [];
    if (i >= n) break;
  }
  return records;
}

// A grid of rows by about 2.2 km of latitude, for the keep-away rule.
const KEEP_AWAY_CELL_DEG = 0.02;
function keepAwayIndex(rows) {
  const grid = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
    const k = `${Math.floor(r.latitude / KEEP_AWAY_CELL_DEG)}_${Math.floor(r.longitude / KEEP_AWAY_CELL_DEG)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(r);
  }
  // The nearest row within `km`, or null. The search reaches as many cells
  // as `km` spans at this latitude, so a high latitude's narrow cells are
  // all read.
  return (lat, lng, km = CORPUS_KEEP_AWAY_KM) => {
    const gy = Math.floor(lat / KEEP_AWAY_CELL_DEG);
    const gx = Math.floor(lng / KEEP_AWAY_CELL_DEG);
    const dy = Math.ceil(km / (111.32 * KEEP_AWAY_CELL_DEG));
    const dx = Math.ceil(km / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)) * KEEP_AWAY_CELL_DEG));
    let best = null;
    for (let y = gy - dy; y <= gy + dy; y++) {
      for (let x = gx - dx; x <= gx + dx; x++) {
        for (const r of grid.get(`${y}_${x}`) || []) {
          const d = kmBetween(lat, lng, r.latitude, r.longitude);
          if (d <= km && (best === null || d < best.km)) best = { row: r, km: d };
        }
      }
    }
    return best;
  };
}

// A timestamp as the snapshot's SELECT writes it (ISO 8601, UTC), or as
// Postgres prints a timestamptz ("2026-11-18 23:45:12.123456+00"); ms, or
// NaN. Microseconds are cut to milliseconds, as fetchedAt holds them.
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/;
function parseTimestamp(text) {
  const m = TIMESTAMP_RE.exec(String(text).trim());
  if (!m) return NaN;
  const frac = m[3] ? m[3].slice(0, 4) : '';
  let zone = m[4];
  if (zone !== 'Z') zone = zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return Date.parse(`${m[1]}T${m[2]}${frac}${zone}`);
}

// planVenues' identities over `rows`: by BestTime id, by Google place id, and
// every row for rule 4.
function identitiesOf(rows) {
  const byBtId = new Map();
  const byPlaceId = new Map();
  for (const r of rows) {
    if (r.besttime_venue_id) byBtId.set(r.besttime_venue_id, r);
    if (r.google_place_id) byPlaceId.set(r.google_place_id, r);
  }
  return { byBtId, byPlaceId, nearby: rows };
}

function loadIdentitySnapshot(file) {
  const records = parseCsv(fs.readFileSync(file, 'utf8'));
  if (records.length === 0) throw new Error(`${file}: empty`);
  const head = records[0].map((h) => h.trim());
  const missing = SNAPSHOT_COLUMNS.filter((c) => !head.includes(c));
  if (missing.length) throw new Error(`${file}: the snapshot lacks ${missing.join(', ')} (plan step C.4's SELECT)`);
  const at = Object.fromEntries(head.map((h, i) => [h, i]));
  const hasStatus = head.includes('besttime_status');
  const hasCreatedAt = head.includes('created_at');
  const rows = [];
  const ids = new Set();
  let noPosition = 0;
  for (let k = 1; k < records.length; k++) {
    const f = records[k];
    if (f.length === 1 && f[0] === '') continue; // a trailing blank line
    if (f.length !== head.length) throw new Error(`${file}: record ${k + 1} has ${f.length} fields, the header ${head.length}`);
    const id = Number(f[at.id]);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`${file}: record ${k + 1} has no integer id`);
    if (ids.has(id)) throw new Error(`${file}: id ${id} twice`);
    ids.add(id);
    const lat = f[at.latitude] === '' ? NaN : Number(f[at.latitude]);
    const lng = f[at.longitude] === '' ? NaN : Number(f[at.longitude]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) noPosition++;
    let createdAtMs;
    if (hasCreatedAt) {
      createdAtMs = f[at.created_at] === '' ? null : parseTimestamp(f[at.created_at]);
      if (Number.isNaN(createdAtMs)) throw new Error(`${file}: record ${k + 1} has created_at "${f[at.created_at]}", not a timestamp`);
    }
    rows.push({
      id,
      besttime_venue_id: f[at.besttime_venue_id] || null,
      google_place_id: f[at.google_place_id] || null,
      name: f[at.name],
      latitude: lat,
      longitude: lng,
      city: f[at.city],
      besttime_status: hasStatus ? (f[at.besttime_status] || null) : undefined,
      createdAtMs,
    });
  }
  const maxId = rows.reduce((m, r) => Math.max(m, r.id), 0);
  if (maxId >= SYNTHETIC_ID_BASE) {
    throw new Error(`${file}: ml_venues ids reach ${maxId}, into the synthetic range from ${SYNTHETIC_ID_BASE}`);
  }
  return {
    file, sha256: sha256File(file), rows: rows.length, maxId, noPosition, hasStatus, hasCreatedAt, columns: head,
    list: rows, ids,
    identities: identitiesOf(rows),
    nearestCorpus: keepAwayIndex(rows),
  };
}

// ---------------------------------------------------------------------------
// The harvest-inclusive export (--export-dir), read once, streamed.
// ---------------------------------------------------------------------------

// Each export file's lines as CSV records' text: a quoted field may hold a
// line break, so a line with an odd count of quotes is joined to the next.
async function* exportRecords(file, onBytes = null) {
  const input = fs.createReadStream(file);
  if (onBytes) input.on('data', onBytes);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let pending = '';
  try {
    for await (const line of lines) {
      const text = pending ? `${pending}\n${line}` : line;
      if (text.includes('"') && (text.match(/"/g) || []).length % 2 === 1) { pending = text; continue; }
      pending = '';
      yield text;
    }
  } finally {
    input.destroy();
  }
  if (pending) throw new Error(`${file}: a quoted field never closes`);
}

// Every venue either file holds, by id, with the first row's position and
// city; each file's SHA-256 (of the bytes read) and data rows.
async function readExportVenues(dir) {
  const venues = new Map();
  const files = [];
  for (const name of EXPORT_FILES) {
    const file = path.join(dir, name);
    const hash = crypto.createHash('sha256');
    let rows = 0;
    let headerSeen = false;
    for await (const text of exportRecords(file, (chunk) => hash.update(chunk))) {
      if (!headerSeen) {
        if (text !== HEADER) throw new Error(`${file} does not open with the export's HEADER`);
        headerSeen = true;
        continue;
      }
      rows++;
      const id = Number(text.slice(0, text.indexOf(',')));
      if (!Number.isInteger(id) || id <= 0) throw new Error(`${file}: data row ${rows} has no venue id`);
      if (venues.has(id)) continue;
      const f = parseCsv(text)[0];
      if (f.length !== HEADER_FIELDS.length) throw new Error(`${file}: data row ${rows} has ${f.length} fields, not ${HEADER_FIELDS.length}`);
      venues.set(id, {
        latitude: f[EXPORT_COLUMNS.latitude] === '' ? NaN : Number(f[EXPORT_COLUMNS.latitude]),
        longitude: f[EXPORT_COLUMNS.longitude] === '' ? NaN : Number(f[EXPORT_COLUMNS.longitude]),
        city: f[CITY_COLUMN],
      });
    }
    if (!headerSeen) throw new Error(`${file} is empty`);
    files.push({ file, sha256: hash.digest('hex'), rows });
  }
  return { dir, files, venues };
}

// What the export says about the snapshot: null when every venue it holds is
// a snapshot row and none is a cache row, else why not.
function exportAgainstSnapshot(exp, snapshot) {
  const absent = [];
  const cacheRows = [];
  for (const [id, v] of exp.venues) {
    if (id >= SYNTHETIC_ID_BASE || v.city === WORLD_CACHE_CITY) cacheRows.push(id);
    else if (!snapshot.ids.has(id)) absent.push(id);
  }
  if (cacheRows.length) {
    return `the export already holds cache rows (${cacheRows.length} venues with an id from ${SYNTHETIC_ID_BASE} or city `
      + `${WORLD_CACHE_CITY}, first ${cacheRows.slice(0, 3).join(', ')}): append to the export as written, once.`;
  }
  if (absent.length) {
    return `${absent.length} of the ${exp.venues.size} venues the export holds are not in the snapshot (first ids `
      + `${absent.sort((a, b) => a - b).slice(0, 5).join(', ')}): it is partial, older than the export or from another `
      + 'database, and the identity rules and the 2 km rule would miss what it lacks. Take it again (plan step C.4).';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Peak hours (see the header).
// ---------------------------------------------------------------------------

// A venue's week-averaged busiest venue-local hour from per-hour sums and
// counts, exactly as harvestVenueFilter.peakHourHistogram reads it from cells:
// the first hour whose mean is the largest, none when every mean is 0.
function peakFromSums(sum, cnt) {
  let peak = -1;
  let peakValue = 0;
  for (let h = 0; h < 24; h++) {
    if (cnt[h] === 0) continue;
    const mean = sum[h] / cnt[h];
    if (mean > peakValue) { peakValue = mean; peak = h; }
  }
  return peak;
}

// The mode of a 24-hour histogram, as formatPeakHistogram prints it (the
// first hour among equals), and its count; null mode when empty.
function histogramMode(hist) {
  let n = 0;
  let mode = 0;
  for (let h = 0; h < 24; h++) {
    n += hist[h];
    if (hist[h] > hist[mode]) mode = h;
  }
  return { n, mode: n > 0 ? mode : null };
}

// b's hour minus a's on the 24-hour circle, -11 to +12.
function hourShift(a, b) {
  const d = (((b - a) % 24) + 24) % 24;
  return d > 12 ? d - 24 : d;
}

// Every harvest-cache answer (the training cities' November harvest), one
// answer per venue and BestTime day (the first, as mergeDay keeps), placed
// among the training cities and the refused ones; the venues placed in a
// training city, by category, pooled and per city.
async function trainingPeakReference(harvestCacheDir) {
  const acc = new Map();
  let files = 0;
  let unreadable = 0;
  const folders = fs.readdirSync(harvestCacheDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const folder of folders) {
    const dir = path.join(harvestCacheDir, folder);
    for (const f of listCacheFiles(dir).sort()) {
      files++;
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        unreadable++;
        continue;
      }
      const list = entry && entry.data && Array.isArray(entry.data.venues) ? entry.data.venues : null;
      if (!list) continue;
      for (const raw of list) {
        const v = H.readFilterVenue(raw);
        if (!v || v.dayInt === null || !v.hours || v.dayInt < 0 || v.dayInt > 6) continue;
        let a = acc.get(v.venueId);
        if (!a) {
          a = { type: v.type, lat: v.lat, lng: v.lng, daysSeen: 0, sum: new Float64Array(24), cnt: new Uint16Array(24) };
          acc.set(v.venueId, a);
        }
        if (a.daysSeen & (1 << v.dayInt)) continue;
        a.daysSeen |= 1 << v.dayInt;
        for (const c of H.weekCells([[v.dayInt, v.hours]])) { a.sum[c.hour] += c.busyness; a.cnt[c.hour]++; }
      }
    }
  }
  const markets = H.otherMarkets(H.ALL_CITIES);
  const training = new Set(H.ALL_CITIES);
  const pooled = new Map();
  const byCity = new Map();
  let venues = 0;
  const bump = (map, category, peak) => {
    if (!map.has(category)) map.set(category, new Int32Array(24));
    map.get(category)[peak]++;
  };
  for (const a of acc.values()) {
    const category = a.type ? H.TYPE_TO_CATEGORY[a.type] : undefined;
    if (!category || !Number.isFinite(a.lat) || !Number.isFinite(a.lng)) continue;
    const where = H.placeVenue(a.lat, a.lng, markets);
    if (!where.cityKey || !training.has(where.cityKey)) continue;
    const peak = peakFromSums(a.sum, a.cnt);
    if (peak < 0) continue;
    venues++;
    bump(pooled, category, peak);
    if (!byCity.has(where.cityKey)) byCity.set(where.cityKey, new Map());
    bump(byCity.get(where.cityKey), category, peak);
  }
  return { dir: harvestCacheDir, folders: folders.length, files, unreadable, venues, pooled, byCity };
}

// Each category's mode against the reference's; flagged when a
// PEAK_FLAG_CATEGORIES mode moves PEAK_SHIFT_FLAG_HOURS or more.
function comparePeaks(hist, reference) {
  const out = {};
  let flagged = false;
  for (const [category, h] of [...hist.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const { n, mode } = histogramMode(h);
    if (mode === null) continue;
    const ref = reference && reference.pooled.get(category) ? histogramMode(reference.pooled.get(category)).mode : null;
    const shift = ref === null ? null : hourShift(ref, mode);
    const flag = PEAK_FLAG_CATEGORIES.includes(category) && shift !== null && Math.abs(shift) >= PEAK_SHIFT_FLAG_HOURS;
    if (flag) flagged = true;
    out[category] = { n, mode, reference: ref, shift, flag };
  }
  return { categories: out, flagged };
}

// ---------------------------------------------------------------------------
// The rows.
// ---------------------------------------------------------------------------

// rating as NUMERIC(2,1) stores it: node-pg sends a number as String(n) and
// Postgres rounds that decimal text half away from zero to one place; the
// export reads it back as text with exactly one decimal ("4.0", "4.4").
function numeric21(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(20);
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [ip, fp = ''] = s.split('.');
  let tenths = Number(ip) * 10 + Number(fp[0] || '0');
  if ((fp[1] || '0') >= '5') tenths += 1;
  const out = `${Math.floor(tenths / 10)}.${tenths % 10}`;
  return neg && tenths !== 0 ? `-${out}` : out;
}

// One weekly row, shaped as export_training_data.cityQuery returns it for a
// harvested venue (see the header for each value's source), for rowToCsv.
function weeklyRow({ venue, category, month }, cell, { venueId, city }) {
  return {
    venue_id: venueId,
    day_of_week: cell.dayOfWeek,
    hour: cell.hour,
    month,
    season: getSeason(month),
    is_holiday: false,
    is_school_break: false,
    venue_category: category,
    price_level: null,
    rating: numeric21(venue.rating),
    review_count: Number.isInteger(venue.reviews) ? venue.reviews : null,
    temperature: null,
    humidity: null,
    wind_speed: null,
    weather_condition: null,
    weather_condition_code: null,
    is_raining: null,
    event_nearby: null,
    event_distance_km: null,
    event_size: null,
    event_type: null,
    event_hours_until: null,
    has_nearby_event: null,
    nearest_event_distance_km: null,
    nearest_event_attendance: null,
    total_nearby_events: null,
    total_nearby_attendance: null,
    nearest_event_type: null,
    // ROUND(AVG(busyness_pct)) over the slot's weekly rows: the venue's one.
    baseline_busyness: String(Math.round(cell.busyness)),
    collection_mode: 'weekly',
    label_source: null,
    vendor_forecast_pct: null,
    events_observed: false,
    live_hour_start: null,
    live_venue_open: null,
    live_local_time: null,
    collected_at: null,
    stored_observed_date: null,
    busyness_pct: cell.busyness,
    city,
    google_types: null,
    latitude: venue.lat,
    longitude: venue.lng,
    avg_user_crowd: '0',
    user_feedback_count: 0,
    avg_prediction_error: '0',
  };
}

// A venue's week as weekCells reads its days (BestTime day order, the first
// answer for a cell kept), in WEEK_SLOTS bytes: day_of_week * 24 + hour,
// ABSENT where there is no cell. readHours rounds every value to 0..100, so
// a byte holds it exactly. A full run keeps about 330k of these: as 168 cell
// objects each, the first version ran out of a 4 GB heap.
function weekOf(days) {
  const week = new Uint8Array(WEEK_SLOTS).fill(ABSENT);
  let rows = 0;
  for (const c of H.weekCells([...days.entries()].sort((a, b) => a[0] - b[0]))) {
    if (!Number.isInteger(c.busyness) || c.busyness < 0 || c.busyness > 100) {
      throw new Error(`busyness ${c.busyness} at day ${c.dayOfWeek} hour ${c.hour} is not a whole 0..100`);
    }
    week[c.dayOfWeek * 24 + c.hour] = c.busyness;
    rows++;
  }
  return { week, rows };
}

// A week's cells in the export's order (day of week, then hour).
function cellsOfWeek(week) {
  const cells = [];
  for (let i = 0; i < WEEK_SLOTS; i++) {
    if (week[i] !== ABSENT) cells.push({ dayOfWeek: Math.floor(i / 24), hour: i % 24, busyness: week[i] });
  }
  return cells;
}

const sortedCells = (venue) => cellsOfWeek(weekOf(venue.days).week);

// harvestVenueFilter.peakHourHistogram over kept venues' weeks: each venue's
// week-averaged busiest venue-local hour (peakFromSums, pinned equal to it
// by the tests), counted by category.
function peakHistogramOfWeeks(kept) {
  const byCategory = new Map();
  const sum = new Float64Array(24);
  const cnt = new Uint16Array(24);
  for (const k of kept) {
    sum.fill(0);
    cnt.fill(0);
    for (let i = 0; i < WEEK_SLOTS; i++) {
      if (k.week[i] === ABSENT) continue;
      sum[i % 24] += k.week[i];
      cnt[i % 24]++;
    }
    const peak = peakFromSums(sum, cnt);
    if (peak < 0) continue;
    if (!byCategory.has(k.category)) byCategory.set(k.category, new Int32Array(24));
    byCategory.get(k.category)[peak]++;
  }
  return byCategory;
}

// ---------------------------------------------------------------------------
// The global pass (see the header).
// ---------------------------------------------------------------------------

function newDropCounter() {
  return {};
}
const countDrop = (counter, reason, n = 1) => { counter[reason] = (counter[reason] || 0) + n; };

// The markets every venue is placed among: every training city and the
// refused four (otherMarkets of every training city), then every cache city
// the cacher reached, in key order.
function globalMarkets(cacheCities) {
  const markets = { ...H.otherMarkets(H.ALL_CITIES) };
  for (const c of [...cacheCities].sort((a, b) => a.key.localeCompare(b.key))) {
    if (!markets[c.key]) markets[c.key] = { lat: c.lat, lon: c.lon };
  }
  return markets;
}

// Why a venue placed in `cityKey` is dropped, or null. A config.js key is
// judged before the accepted set, so a training city's key can never pass as
// a cache city (classifyCities refuses one; this does not rely on it).
function placementDrop(cityKey, accepted) {
  if (!cityKey) return 'outsideMarkets';
  if (HOLDOUT_CITIES.includes(cityKey)) return 'placedInHoldoutCity';
  if (cityKey === 'beijing') return 'placedInBeijing';
  if (PA_CITIES[cityKey] || CITIES[cityKey]) return 'placedInTrainingCity';
  if (accepted.has(cityKey)) return null;
  return 'placedInRefusedCacheCity';
}

// The holdout city or beijing within MAX_KM of a point, or null.
const nearHoldout = (lat, lng) => FAR_FROM.find((c) => kmBetween(lat, lng, c.lat, c.lon) <= MAX_KM) || null;

// `nearestCorpus` (the 2 km rule) is the snapshot's own index, or one over
// the snapshot and the export's positions when --export-dir is given.
function globalPass({ cacheCities, accepted, snapshot, nearestCorpus = snapshot ? snapshot.nearestCorpus : null }) {
  const acceptedKeys = new Set(accepted.map((c) => c.key));
  const byKey = new Map(accepted.map((c) => [c.key, c]));
  const markets = globalMarkets(cacheCities);
  const drops = new Map(accepted.map((c) => [c.key, newDropCounter()]));
  const home = new Map(); // venueId -> the city its counts go to
  const trainingPlaced = {};
  // Inside a circle the cacher asked: the city it is placed in first, then
  // any other accepted one (see the header).
  const insideRadius = (v, where) => where.km <= byKey.get(where.cityKey).radiusKm
    || accepted.some((c) => kmBetween(v.lat, v.lng, c.lat, c.lon) <= c.radiusKm);

  // One record per venue: the city it is placed in's own, when that city
  // found it, else the first city (by key) that did; days the record lacks
  // are filled from the others.
  const found = new Map();
  for (const c of [...accepted].sort((a, b) => a.key.localeCompare(b.key))) {
    for (const v of c.replay.venues.values()) {
      if (v.days.size === 0) continue;
      if (!found.has(v.venueId)) found.set(v.venueId, []);
      found.get(v.venueId).push({ city: c.key, v });
    }
  }
  const candidates = [];
  let inTwoCircles = 0;
  let daysFilled = 0;
  for (const [venueId, records] of found) {
    if (records.length > 1) inTwoCircles++;
    const first = records[0];
    const lat = first.v.lat;
    const lng = first.v.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      home.set(venueId, first.city);
      countDrop(drops.get(first.city), 'noCoordinates');
      continue;
    }
    const where = H.placeVenue(lat, lng, markets);
    const drop = placementDrop(where.cityKey, acceptedKeys);
    if (drop) {
      home.set(venueId, first.city);
      countDrop(drops.get(first.city), drop);
      if (drop === 'placedInTrainingCity') trainingPlaced[where.cityKey] = (trainingPlaced[where.cityKey] || 0) + 1;
      continue;
    }
    home.set(venueId, where.cityKey);
    if (nearHoldout(lat, lng)) {
      countDrop(drops.get(where.cityKey), NEAR_HOLDOUT_DROP);
      continue;
    }
    const primary = records.find((r) => r.city === where.cityKey) || first;
    const venue = { ...primary.v, days: new Map(primary.v.days) };
    for (const r of records) {
      if (r === primary) continue;
      for (const [day, hours] of r.v.days) {
        if (!venue.days.has(day)) { venue.days.set(day, hours); daysFilled++; }
      }
    }
    candidates.push({ venue, sourceCity: primary.city, foundIn: records.map((r) => r.city) });
  }
  const sourceOf = new Map(candidates.map((c) => [c.venue.venueId, c]));

  const identities = snapshot ? snapshot.identities : { byBtId: new Map(), byPlaceId: new Map(), nearby: [] };
  const { plan, skipped } = H.planVenues(candidates.map((c) => c.venue), identities, [...acceptedKeys], {
    markets,
    insideRadius,
    onSkip: (v, reason) => countDrop(drops.get(home.get(v.venueId)), reason),
  });
  for (const reason of ['outsideMarkets', 'otherMarket', 'noCoordinates']) {
    // Placed above among the same markets: the planner can never disagree.
    if (skipped[reason] !== 0) throw new Error(`planVenues skipped ${skipped[reason]} venues as ${reason} after placement`);
  }
  const kept = [];
  for (const item of plan) {
    if (item.kind !== 'new') {
      countDrop(drops.get(item.city), IDENTITY_DROPS[item.kind]);
      continue;
    }
    if (nearestCorpus && nearestCorpus(item.venue.lat, item.venue.lng)) {
      countDrop(drops.get(item.city), KEEP_AWAY_DROP);
      continue;
    }
    const src = sourceOf.get(item.venue.venueId);
    const month = byKey.get(src.sourceCity).replay.month;
    const v = item.venue;
    const { week, rows } = weekOf(v.days);
    kept.push({
      venue: { venueId: v.venueId, name: v.name, placeId: v.placeId, lat: v.lat, lng: v.lng, rating: v.rating, reviews: v.reviews },
      city: item.city, category: item.category, month, week, rows, daysHeld: v.days.size, foundIn: src.foundIn,
    });
  }
  const homeCount = new Map();
  for (const key of home.values()) homeCount.set(key, (homeCount.get(key) || 0) + 1);
  return { kept, drops, homeCount, distinct: found.size, inTwoCircles, daysFilled, trainingPlaced };
}

// ---------------------------------------------------------------------------
// The run (dry run and write).
// ---------------------------------------------------------------------------
const num = (n) => Number(n).toLocaleString('en-US');
const dropText = (counter) => Object.entries(counter).filter(([, n]) => n > 0)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${num(n)}`).join(', ');

function gitState() {
  const cwd = __dirname;
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const files = [__filename, path.join(__dirname, '..', 'harvestVenueFilter.js'), path.join(__dirname, 'export_training_data.js')];
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ...files],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { commit, toolFilesClean: dirty === '' };
  } catch {
    return { commit: null, toolFilesClean: null };
  }
}

function formatReferenceLines(reference) {
  const lines = [`${TAG} TRAINING CITIES' PEAK HOURS (${reference.dir}: ${num(reference.files)} answers in ${reference.folders} `
    + `folders, ${num(reference.venues)} venues placed in a training city${reference.unreadable ? `, ${reference.unreadable} unreadable files` : ''}). `
    + 'Venues whose week-averaged busiest venue-local hour is that hour:'];
  for (const l of H.formatPeakHistogram(reference.pooled)) lines.push(l);
  for (const category of PEAK_FLAG_CATEGORIES) {
    const modes = [...reference.byCity.entries()]
      .map(([city, m]) => [city, m.get(category) ? histogramMode(m.get(category)) : { n: 0, mode: null }])
      .filter(([, x]) => x.n >= 20)
      .map(([city, x]) => `${city} ${String(x.mode).padStart(2, '0')}h`);
    lines.push(`  ${category} mode by training city (20+ venues): ${modes.join(', ') || 'none'}`);
  }
  // The same rule turned on the training cities themselves, for scale: a
  // flag there is a city the model already trains on.
  const own = [...reference.byCity.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([city, m]) => [city, comparePeaks(m, reference)])
    .filter(([, p]) => p.flagged)
    .map(([city, p]) => `${city} (${PEAK_FLAG_CATEGORIES.filter((c) => p.categories[c] && p.categories[c].flag)
      .map((c) => `${c} ${p.categories[c].mode}h n=${p.categories[c].n}`).join(', ')})`);
  lines.push(`  training cities the ${PEAK_SHIFT_FLAG_HOURS} h rule would flag against the pooled modes: ${own.join('; ') || 'none'}`);
  return lines;
}

function peakText(peaks) {
  return Object.entries(peaks.categories).map(([category, p]) => {
    const shift = p.shift === null ? '' : ` ${p.shift >= 0 ? '+' : ''}${p.shift}`;
    return `${category} ${String(p.mode).padStart(2, '0')}h n=${p.n}${shift}${p.flag ? ' FLAG' : ''}`;
  }).join(', ');
}

async function runImport(opts, { log }) {
  const started = new Date().toISOString();
  const plan = loadPlan(opts.plan);
  const progress = loadProgress(opts.progress);
  const cities = classifyCities(plan, progress, opts.cacheRoot, { only: opts.only });
  log(`${TAG} ${opts.mode === 'write' ? 'WRITE' : 'DRY RUN (nothing is written)'}: ${plan.length} plan entries, `
    + `${cities.cacheCities.length} the cacher reached, ${cities.replay.length} folders to replay from ${opts.cacheRoot}. `
    + `Folders never opened: ${cities.foldersNotRead.join(', ') || 'none'}. No database, no network.`);

  // The snapshot and the export first: a snapshot the export shows is not
  // the whole of ml_venues stops the run before any folder is replayed.
  let snapshot = null;
  let exported = null;
  let nearestCorpus = null;
  if (opts.identitySnapshot) {
    snapshot = loadIdentitySnapshot(opts.identitySnapshot);
    log(`${TAG} IDENTITY SNAPSHOT: ${opts.identitySnapshot}, ${num(snapshot.rows)} ml_venues rows (highest id `
      + `${num(snapshot.maxId)}, ${snapshot.noPosition} without a position), sha256 ${snapshot.sha256}.`);
    nearestCorpus = snapshot.nearestCorpus;
  } else {
    log(`${TAG} IDENTITY SNAPSHOT: none given. Identity rules 1-4 and the ${CORPUS_KEEP_AWAY_KM} km rule are PENDING SNAPSHOT: `
      + 'every count below is before them, and --write refuses until they run.');
  }
  if (opts.exportDir) {
    exported = await readExportVenues(opts.exportDir);
    log(`${TAG} EXPORT: ${exported.files.map((f) => `${path.basename(f.file)} ${num(f.rows)} rows (sha256 ${f.sha256})`).join(', ')}; `
      + `${num(exported.venues.size)} venues, every one checked against the snapshot.`);
    const why = exportAgainstSnapshot(exported, snapshot);
    if (why) {
      log(`${TAG} REFUSED: ${why} Nothing was replayed${opts.mode === 'write' ? ' or written' : ''}.`);
      return { exitCode: 1, refused: why };
    }
    const points = [...exported.venues].map(([id, v]) => ({ id, latitude: v.latitude, longitude: v.longitude }));
    nearestCorpus = keepAwayIndex([...snapshot.list, ...points]);
  } else if (snapshot) {
    log(`${TAG} EXPORT: none given, so the snapshot is not checked against it and the ${CORPUS_KEEP_AWAY_KM} km rule reads `
      + 'the snapshot alone; --write refuses without it.');
  }

  for (const city of cities.replay) {
    await replayCity(city);
  }
  const accepted = cities.replay.filter((c) => c.refused.length === 0);
  const refusedWithData = cities.cacheCities.filter((c) => c.refused.length > 0);

  const pass = globalPass({ cacheCities: cities.cacheCities, accepted, snapshot, nearestCorpus });
  // Everything the rows need is in pass.kept now.
  for (const city of accepted) city.replay.venues = null;

  let reference = null;
  if (opts.harvestCache) {
    reference = await trainingPeakReference(opts.harvestCache);
    for (const l of formatReferenceLines(reference)) log(l);
  } else {
    log(`${TAG} PEAK HOURS: no --harvest-cache, so no training reference; every city's peak check is NOT RUN.`);
  }

  // Per city: counts, drops, rows, peaks.
  const keptByCity = new Map(accepted.map((c) => [c.key, []]));
  for (const k of pass.kept) keptByCity.get(k.city).push(k);
  const report = { cities: {}, totals: {} };
  const flagged = [];
  log(`${TAG} BY CITY: files read of held; misses against progress.json's 404s; venues found by the city's replay; `
    + 'home venues (placed here, or found here and dropped); kept; weekly rows; records malformed and without a day, '
    + 'boxes cut at the cap, stray files; drops; peak hour per category '
    + `(mode, venues, hours from the training mode${reference ? '' : ': not run'}).`);
  const records = (r) => ({ malformed: r.malformed, unverifiable: r.unverifiable, truncatedTiles: r.truncatedTiles, strayFiles: r.strayFiles });
  const recordText = (r) => `malformed ${r.malformed}  no day ${num(r.unverifiable)}  cut ${r.truncatedTiles}  stray ${r.strayFiles}`;
  for (const city of [...accepted].sort((a, b) => a.key.localeCompare(b.key))) {
    const r = city.replay;
    const kept = keptByCity.get(city.key);
    const rows = kept.reduce((n, k) => n + k.rows, 0);
    const hist = peakHistogramOfWeeks(kept);
    const peaks = comparePeaks(hist, reference);
    if (peaks.flagged) flagged.push(city.key);
    const drops = pass.drops.get(city.key);
    report.cities[city.key] = {
      state: 'accepted', radiusKm: city.radiusKm, filesHeld: r.filesHeld, filesRead: r.filesRead, misses: r.misses,
      notFound: city.notFound, venuesFound: r.venuesFound, homeVenues: pass.homeCount.get(city.key) || 0, kept: kept.length,
      incompleteWeeks: kept.filter((k) => k.daysHeld < 7).length, rows, drops, month: r.month, ...records(r),
      fetchedAt: r.fetchedAt, peaks: reference ? peaks.categories : null, peakFlag: reference ? peaks.flagged : null,
    };
    log(`  ${city.key.padEnd(16)} files ${r.filesRead}/${r.filesHeld}  misses ${r.misses} = notFound ${city.notFound}  `
      + `found ${num(r.venuesFound)}  home ${num(pass.homeCount.get(city.key) || 0)}  kept ${num(kept.length)}  rows ${num(rows)}  `
      + `${recordText(r)}${peaks.flagged ? '  PEAK FLAG' : ''}`);
    log(`      drops: ${dropText(drops) || 'none'}`);
    if (reference) log(`      peak: ${peakText(peaks)}`);
  }
  const refusedList = [];
  for (const city of cities.all.filter((c) => c.refused.length > 0).sort((a, b) => a.key.localeCompare(b.key))) {
    refusedList.push(city.key);
    report.cities[city.key] = {
      state: 'refused', opened: city.opened, reasons: city.refused,
      ...(city.replay ? {
        filesHeld: city.replay.filesHeld, filesRead: city.replay.filesRead, misses: city.replay.misses,
        notFound: city.notFound, venuesFound: city.replay.venuesFound, ...records(city.replay),
      } : {}),
    };
  }
  log(`${TAG} REFUSED (${refusedList.length}):`);
  for (const key of refusedList) {
    const c = report.cities[key];
    const ev = c.filesHeld !== undefined
      ? ` [replayed: files ${c.filesRead}/${c.filesHeld}, misses ${c.misses} vs notFound ${c.notFound}, ${num(c.venuesFound)} venues, `
        + `${recordText(c)}]`
      : ' [never opened]';
    log(`  ${key.padEnd(16)} ${c.reasons.map((x) => `${x.reason}: ${x.detail}`).join('; ')}${ev}`);
  }
  const unreached = cities.all.filter((c) => c.unreached).map((c) => c.key);

  const totalDrops = {};
  for (const counter of pass.drops.values()) for (const [k, n] of Object.entries(counter)) countDrop(totalDrops, k, n);
  const rowsAll = pass.kept.reduce((n, k) => n + k.rows, 0);
  const flaggedSet = new Set(flagged);
  const keptUnflagged = pass.kept.filter((k) => !flaggedSet.has(k.city));
  const rowsUnflagged = keptUnflagged.reduce((n, k) => n + k.rows, 0);
  // Counted again from the kept venues themselves: the drop above makes it 0,
  // and --write refuses if it ever is not.
  const keptNearHoldout = pass.kept.filter((k) => nearHoldout(k.venue.lat, k.venue.lng)).length;
  const recordTotals = { malformed: 0, unverifiable: 0, truncatedTiles: 0, strayFiles: 0 };
  for (const city of accepted) for (const k of Object.keys(recordTotals)) recordTotals[k] += city.replay[k];
  report.totals = {
    citiesInPlan: plan.length, cacheCities: cities.cacheCities.length, accepted: accepted.length,
    refused: refusedList.length, refusedCacheCities: refusedWithData.length, unreached: unreached.length,
    distinctVenues: pass.distinct, venuesInTwoCircles: pass.inTwoCircles, daysFilledFromAnotherCity: pass.daysFilled,
    kept: pass.kept.length, rows: rowsAll, drops: totalDrops, placedInTrainingCity: pass.trainingPlaced,
    keptWithin80kmOfHoldoutOrBeijing: keptNearHoldout,
    acceptedRecords: recordTotals,
    identityRules: snapshot ? 'applied' : 'pending snapshot',
    keepAwayRule: snapshot ? (exported ? 'applied (snapshot and export)' : 'applied (snapshot only)') : 'pending snapshot',
    exportChecked: exported ? exported.files.map((f) => ({ file: f.file, sha256: f.sha256, rows: f.rows })) : null,
    peakCheck: reference ? 'run' : 'not run',
    peakFlagged: flagged,
    keptIfFlaggedRefused: keptUnflagged.length,
    rowsIfFlaggedRefused: rowsUnflagged,
  };
  const t = report.totals;
  log(`${TAG} TOTALS: ${t.accepted} cities accepted, ${t.refused} refused (${t.refusedCacheCities} of them cities the cacher `
    + `reached, the rest config or refused keys), ${t.unreached} plan cities the cacher never reached. ${num(t.distinctVenues)} distinct venues `
    + `(${num(t.venuesInTwoCircles)} in two circles, counted once; ${num(t.daysFilledFromAnotherCity)} venue-days filled from `
    + `the other circle), ${num(t.kept)} kept, ${num(t.rows)} weekly rows. Identity rules: ${t.identityRules}; `
    + `${CORPUS_KEEP_AWAY_KM} km rule: ${t.keepAwayRule}; peak check: ${t.peakCheck}. Accepted cities' records: `
    + `${recordText(recordTotals)}.`);
  log(`${TAG} DROPS: ${dropText(totalDrops) || 'none'}.`);
  log(`${TAG} Placed in a training city, by city: ${dropText(pass.trainingPlaced) || 'none'}. `
    + `Kept venues within ${MAX_KM} km of a holdout or beijing centroid: ${keptNearHoldout}.`);
  if (reference) {
    // n under PEAK_FEW_VENUES is marked: a mode of a handful of venues says
    // little about the city's axis.
    log(`${TAG} PEAK FLAGS (${flagged.length}, a bar or nightclub mode ${PEAK_SHIFT_FLAG_HOURS} h or more from the training `
      + `cities'; "few" marks a mode of fewer than ${PEAK_FEW_VENUES} venues): ${flagged.map((k) => {
        const p = report.cities[k].peaks;
        return `${k} (${PEAK_FLAG_CATEGORIES.filter((c) => p[c] && p[c].flag).map((c) => `${c} ${p[c].mode}h n=${p[c].n}`
          + `${p[c].n < PEAK_FEW_VENUES ? ' few' : ''} ${p[c].shift >= 0 ? '+' : ''}${p[c].shift}`).join(', ')})`;
      }).join('; ') || 'none'}. Refusing them all keeps ${num(t.keptIfFlaggedRefused)} venues, ${num(t.rowsIfFlaggedRefused)} rows.`);
  }

  const result = { exitCode: 0, report, kept: pass.kept, flagged, snapshot, exported, reference, started };
  if (opts.reportJson) {
    fs.writeFileSync(opts.reportJson, JSON.stringify(report, null, 1));
    log(`${TAG} Report written to ${opts.reportJson}.`);
  }
  if (opts.mode !== 'write') return result;
  return writeOutputs(opts, result, { log, cities, plan });
}

// ---------------------------------------------------------------------------
// --write (plan step C.7).
// ---------------------------------------------------------------------------
function finished(stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.end(resolve);
  });
}

async function writeChunk(stream, text) {
  if (!stream.write(text)) await new Promise((resolve) => stream.once('drain', resolve));
}

async function writeOutputs(opts, result, { log }) {
  const fail = (why) => {
    log(`${TAG} REFUSED: ${why} Nothing was written.`);
    return { ...result, exitCode: 1, refusedWrite: why };
  };
  if (!result.snapshot || !result.exported) return fail('--write needs the snapshot checked against the export.');
  const nearHoldoutKept = result.report.totals.keptWithin80kmOfHoldoutOrBeijing;
  if (nearHoldoutKept !== 0) {
    return fail(`${nearHoldoutKept} kept venues are within ${MAX_KM} km of a holdout or beijing centroid; the drop that `
      + 'keeps them out did not run.');
  }
  const unknownAccepts = opts.acceptPeakFlags.filter((k) => !result.flagged.includes(k));
  if (unknownAccepts.length) return fail(`--accept-peak-flags names cities that are not flagged: ${unknownAccepts.join(', ')}.`);
  const refusedFlags = result.flagged.filter((k) => !opts.acceptPeakFlags.includes(k));
  const keep = result.kept.filter((k) => !refusedFlags.includes(k.city))
    .sort((a, b) => a.city.localeCompare(b.city) || (a.venue.venueId < b.venue.venueId ? -1 : a.venue.venueId > b.venue.venueId ? 1 : 0));
  if (keep.length === 0) return fail('no venue is left to write.');
  if (SYNTHETIC_ID_BASE + keep.length - 1 > INT32_MAX) return fail('the synthetic ids would pass int32.');
  fs.mkdirSync(opts.outDir, { recursive: true });
  const target = (name) => path.join(opts.outDir, name);
  const existing = Object.values(OUTPUT_FILES).filter((f) => fs.existsSync(target(f)) || fs.existsSync(`${target(f)}.partial`));
  if (existing.length) return fail(`${opts.outDir} already holds ${existing.join(', ')}.`);
  const git = gitState();

  const rowsFile = target(OUTPUT_FILES.rows);
  const venuesFile = target(OUTPUT_FILES.venues);
  const rowsOut = fs.createWriteStream(`${rowsFile}.partial`);
  const venuesOut = fs.createWriteStream(`${venuesFile}.partial`);
  await writeChunk(rowsOut, `${HEADER}\n`);
  await writeChunk(venuesOut, 'synthetic_venue_id,city,besttime_venue_id,google_place_id,name,latitude,longitude,'
    + 'venue_category,days,rows,found_in\n');
  const csv = (vals) => vals.map((v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
  let rows = 0;
  for (let i = 0; i < keep.length; i++) {
    const k = keep[i];
    const venueId = SYNTHETIC_ID_BASE + i;
    let chunk = '';
    const cells = cellsOfWeek(k.week);
    if (cells.length !== k.rows) throw new Error(`${k.venue.venueId}: ${cells.length} cells, ${k.rows} counted`);
    for (const cell of cells) {
      chunk += `${rowToCsv(weeklyRow(k, cell, { venueId, city: WORLD_CACHE_CITY }))}\n`;
      rows++;
    }
    await writeChunk(rowsOut, chunk);
    await writeChunk(venuesOut, `${csv([venueId, k.city, k.venue.venueId, k.venue.placeId, k.venue.name, k.venue.lat,
      k.venue.lng, k.category, k.daysHeld, k.rows, k.foundIn.join(' ')])}\n`);
  }
  await finished(rowsOut);
  await finished(venuesOut);
  fs.renameSync(`${rowsFile}.partial`, rowsFile);
  fs.renameSync(`${venuesFile}.partial`, venuesFile);

  const manifest = {
    tool: 'backend/scripts/ml/train/importFilterCache.js --write',
    started: result.started,
    finished: new Date().toISOString(),
    git,
    rules: {
      cacher: CACHER, worldCacheCity: WORLD_CACHE_CITY, syntheticIdBase: SYNTHETIC_ID_BASE,
      corpusKeepAwayKm: CORPUS_KEEP_AWAY_KM, peakShiftFlagHours: PEAK_SHIFT_FLAG_HOURS, peakFlagCategories: PEAK_FLAG_CATEGORIES,
      acceptedPeakFlags: opts.acceptPeakFlags, refusedForPeakFlags: refusedFlags,
    },
    inputs: {
      cacheRoot: opts.cacheRoot,
      plan: { file: opts.plan, sha256: sha256File(opts.plan) },
      progress: { file: opts.progress, sha256: sha256File(opts.progress) },
      identitySnapshot: { file: result.snapshot.file, sha256: result.snapshot.sha256, rows: result.snapshot.rows },
      export: {
        dir: result.exported.dir,
        files: result.exported.files.map((f) => ({ file: path.basename(f.file), sha256: f.sha256, rows: f.rows })),
        venues: result.exported.venues.size,
        note: 'every venue id here is a snapshot row; the 2 km rule read these positions too',
      },
      harvestCache: { dir: result.reference.dir, files: result.reference.files },
    },
    outputs: {
      rows: { file: OUTPUT_FILES.rows, sha256: sha256File(rowsFile), bytes: fs.statSync(rowsFile).size, header: HEADER, dataRows: rows,
        note: 'append to training_data.csv without this file\'s first line (the header)' },
      venues: { file: OUTPUT_FILES.venues, sha256: sha256File(venuesFile), bytes: fs.statSync(venuesFile).size, venues: keep.length },
      syntheticIds: { first: SYNTHETIC_ID_BASE, last: SYNTHETIC_ID_BASE + keep.length - 1 },
    },
    report: result.report,
  };
  fs.writeFileSync(target(OUTPUT_FILES.manifest), JSON.stringify(manifest, null, 1));
  log(`${TAG} WROTE ${num(rows)} rows for ${num(keep.length)} venues to ${rowsFile} (sha256 ${manifest.outputs.rows.sha256}), `
    + `the sidecar ${venuesFile} and ${target(OUTPUT_FILES.manifest)}. Commit ${git.commit || 'unknown'}`
    + `${git.toolFilesClean === false ? ' WITH UNCOMMITTED CHANGES to the tool files' : ''}.`
    + `${refusedFlags.length ? ` Refused for peak flags: ${refusedFlags.join(', ')}.` : ''}`);
  return { ...result, exitCode: 0, manifest };
}

// ---------------------------------------------------------------------------
// --parity (plan step C.5).
// ---------------------------------------------------------------------------
// Which venues of a parity replay this folder's runs wrote (see the header):
// `expected` by stored id, and every other venue the replay found, counted by
// why it is left out.
function parityVenues(r, snapshot, cities, radiusKm) {
  const t0 = Date.parse(r.fetchedAt.min);
  // The corpus as the folder's first answer found it. A row with no
  // created_at is taken as older: it can only make a venue known, never new.
  const before = snapshot.list.filter((row) => row.createdAtMs === null || row.createdAtMs < t0);
  const all = [...r.venues.values()].filter((v) => v.days.size > 0);
  const { plan } = H.planVenues(all, identitiesOf(before), cities, { radiusKm });
  const expected = new Map();
  const left = {
    heldBeforeFirstAnswer: 0, // known by BestTime id, place id or a near duplicate before T0
    neverWritten: 0, // planned new, and no row carries its BestTime id
    storedUnderAnotherStatus: 0, // its row is not 'harvested'
    writtenBeforeItsAnswerHere: 0, // its row is older than an answer here that lists it: another pass wrote it
    noCreatedAt: 0,
    notPlannedNew: 0, // skipped by the replay's own rules (radius, type, name, signal, twins, claims)
  };
  const planned = new Set();
  for (const item of plan) {
    planned.add(item.venue.venueId);
    if (item.kind !== 'new') { left.heldBeforeFirstAnswer++; continue; }
    const stored = snapshot.identities.byBtId.get(item.venue.venueId);
    if (!stored) { left.neverWritten++; continue; }
    if (stored.besttime_status !== H.HARVEST_STATUS) { left.storedUnderAnotherStatus++; continue; }
    if (stored.createdAtMs === null) { left.noCreatedAt++; continue; }
    const lastAnswer = r.venueAnswered.get(item.venue.venueId);
    if (!(stored.createdAtMs >= lastAnswer)) { left.writtenBeforeItsAnswerHere++; continue; }
    expected.set(stored.id, {
      item: { venue: item.venue, category: item.category, month: r.month }, city: stored.city,
      cells: sortedCells(item.venue), seen: new Set(),
    });
  }
  // A venue the corpus holds as harvested that this folder did not write:
  // the other pass's, or a venue search's. Its rows are someone else's
  // answers, so it is counted here and never compared.
  let harvestedElsewhere = 0;
  for (const v of all) {
    if (!planned.has(v.venueId)) left.notPlannedNew++;
    const stored = snapshot.identities.byBtId.get(v.venueId);
    if (stored && stored.besttime_status === H.HARVEST_STATUS && !expected.has(stored.id)) harvestedElsewhere++;
  }
  return { expected, left, harvestedElsewhere, t0 };
}

async function runParity(opts, { log }) {
  const snapshot = loadIdentitySnapshot(opts.identitySnapshot);
  const lacking = PARITY_SNAPSHOT_COLUMNS.filter((c) => !snapshot.columns.includes(c));
  if (lacking.length) {
    log(`${TAG} PARITY REFUSED: the snapshot lacks ${lacking.join(' and ')}, so which venues this folder's runs wrote `
      + 'cannot be told from those another pass wrote (see THE SNAPSHOT in the header).');
    return { exitCode: 1 };
  }
  const r = await replayFolder({ dir: opts.cacheDir, cities: opts.cities, radiusKm: opts.radiusKm, venueAnswered: true });
  log(`${TAG} PARITY: replayed ${opts.cities.join(' + ')} within ${opts.radiusKm} km from ${opts.cacheDir}: files `
    + `${r.filesRead}/${r.filesHeld} read, ${r.misses} misses${opts.expectMisses === null ? '' : ` (expected ${opts.expectMisses})`}, `
    + `${num(r.venuesFound)} venues, month ${r.month === null ? 'UNKNOWN' : r.month}, answers fetched ${r.fetchedAt.min} to `
    + `${r.fetchedAt.max}.`);
  if (r.abort) { log(`${TAG} PARITY REFUSED: ${r.abort}`); return { exitCode: 1, abort: r.abort }; }
  if (r.month === null) { log(`${TAG} PARITY REFUSED: the answers do not fix one month.`); return { exitCode: 1 }; }
  if (opts.expectMisses !== null && r.misses !== opts.expectMisses) {
    log(`${TAG} PARITY REFUSED: ${r.misses} misses, ${opts.expectMisses} expected.`);
    return { exitCode: 1 };
  }
  const { expected, left, harvestedElsewhere } = parityVenues(r, snapshot, opts.cities, opts.radiusKm);
  log(`${TAG} PARITY: ${num(expected.size)} venues this folder's runs wrote to compare (planned new against the corpus `
    + `before ${r.fetchedAt.min}, stored 'harvested', created after every answer here that lists them). Left out: `
    + `${dropText(left) || 'none'}. Of those, ${num(harvestedElsewhere)} are stored 'harvested' from another pass's answers, `
    + 'never compared.');
  const header = HEADER_FIELDS;
  const mismatches = Object.fromEntries(header.map((h) => [h, 0]));
  const examples = [];
  let rowsCompared = 0;
  let rowsEqual = 0;
  let extra = 0;
  let nonWeeklySkipped = 0;
  let headerSeen = false;
  for await (const text of exportRecords(opts.exportCsv)) {
    if (!headerSeen) {
      if (text !== HEADER) {
        log(`${TAG} PARITY REFUSED: ${opts.exportCsv} does not open with the export's HEADER.`);
        return { exitCode: 1 };
      }
      headerSeen = true;
      continue;
    }
    const comma = text.indexOf(',');
    const id = Number(text.slice(0, comma));
    const exp = expected.get(id);
    if (!exp) continue;
    const got = parseCsv(text)[0];
    // A live reading (or a user report) of the same venue and slot is no
    // weekly cell: the generator writes weekly rows only.
    if (got[EXPORT_COLUMNS.isRealtime] !== '0' || got[EXPORT_COLUMNS.labelProvenance] !== 'weekly') {
      nonWeeklySkipped++;
      continue;
    }
    const dow = Number(got[1]);
    const hour = Number(got[2]);
    const cell = exp.cells.find((c) => c.dayOfWeek === dow && c.hour === hour);
    if (!cell) { extra++; continue; }
    exp.seen.add(dow * 24 + hour);
    const want = parseCsv(rowToCsv(weeklyRow(exp.item, cell, { venueId: id, city: exp.city })))[0];
    rowsCompared++;
    let same = got.length === want.length;
    for (let i = 0; i < header.length; i++) {
      if (i === CITY_COLUMN) continue;
      if (got[i] !== want[i]) {
        same = false;
        mismatches[header[i]]++;
        if (examples.length < 10) examples.push(`venue ${id} day ${dow} hour ${hour}: ${header[i]} export "${got[i]}", generated "${want[i]}"`);
      }
    }
    if (same) rowsEqual++;
  }
  let missing = 0;
  let venuesAbsent = 0;
  for (const exp of expected.values()) {
    if (exp.seen.size === 0) venuesAbsent++;
    missing += exp.cells.length - exp.seen.size;
  }
  const columns = Object.entries(mismatches).filter(([, n]) => n > 0);
  log(`${TAG} PARITY: ${num(rowsCompared)} rows compared, ${num(rowsEqual)} equal in every column but city; `
    + `${num(missing)} generated rows absent from the export (${venuesAbsent} venues with none there), `
    + `${num(extra)} weekly export rows of these venues not generated; ${num(nonWeeklySkipped)} live or reported rows of `
    + 'theirs skipped.');
  log(`${TAG} PARITY mismatches by column: ${columns.map(([k, n]) => `${k} ${num(n)}`).join(', ') || 'none'}.`);
  for (const e of examples) log(`  ${e}`);
  const pass = expected.size > 0 && rowsCompared > 0 && rowsEqual === rowsCompared && missing === 0 && extra === 0;
  log(`${TAG} PARITY ${pass ? 'PASS' : 'FAIL'}.`);
  return {
    exitCode: pass ? 0 : 1, venues: expected.size, rowsCompared, rowsEqual, missing, extra, nonWeeklySkipped, mismatches,
    examples, left, harvestedElsewhere,
  };
}

// ---------------------------------------------------------------------------
async function run(argv = process.argv, { log = console.log } = {}) {
  const opts = parseImportArgs(argv);
  if (opts.error) {
    log(`${TAG} ${opts.error}`);
    return { exitCode: 2, error: opts.error };
  }
  return H.withNoNetwork(() => (opts.mode === 'parity' ? runParity(opts, { log }) : runImport(opts, { log })));
}

module.exports = {
  run,
  parseImportArgs,
  runFolderScope,
  loadPlan,
  loadProgress,
  classifyCities,
  replayFolder,
  replayCity,
  monthAcrossZones,
  parseCsv,
  parseTimestamp,
  loadIdentitySnapshot,
  readExportVenues,
  keepAwayIndex,
  peakFromSums,
  histogramMode,
  hourShift,
  trainingPeakReference,
  comparePeaks,
  numeric21,
  weeklyRow,
  sortedCells,
  weekOf,
  cellsOfWeek,
  globalMarkets,
  globalPass,
  WORLD_CACHE_CITY,
  SYNTHETIC_ID_BASE,
  CORPUS_KEEP_AWAY_KM,
  PEAK_SHIFT_FLAG_HOURS,
  CACHER,
  OUTPUT_FILES,
};

if (require.main === module) {
  run().then((res) => { process.exitCode = res.exitCode; }).catch((err) => {
    console.error(`${TAG} FAILED: ${(err && err.message) || 'unknown error'}`);
    process.exitCode = 1;
  });
}
