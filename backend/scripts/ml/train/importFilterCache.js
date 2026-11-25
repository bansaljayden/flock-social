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
//        [--feedback-snapshot=<venue_feedback_verified.csv>]  the rows' feedback columns
//   node scripts/ml/train/importFilterCache.js --write --out-dir=<dir> (the same inputs; the
//        snapshot, --export-dir, --harvest-cache and --feedback-snapshot are required)
//        [--accept-peak-flags=<key,...>]
//   node scripts/ml/train/importFilterCache.js --parity --cache-dir=<one harvest-cache run folder>
//        --cities=<the run's --city keys> --radius-km=<its radius> --identity-snapshot=<csv>
//        --export-csv=<the harvest-inclusive training_data.csv> --expect-misses=<n>
//        --written-before=<ISO UTC instant>
//
// NO KEY. No module this script loads reads a BestTime key variable or loads
// backend/.env when it is loaded (harvestVenueFilter.js, collectWeekly.js,
// discoverBestTime.js and addDemandVenues.js load that file only as their own
// commands, and discoverBestTime.js reads its key only when it searches), and
// what it prints is never screened against one. The only way a key can reach
// this process is its environment, so every mode refuses to run while any
// BESTTIME_API_KEY* variable is set, by name (its value is never read): as a
// script, before any module of this repository is loaded, and again in run().
// A run that goes on has had no key in its process at any point and has
// read no key variable.
//
// THE SNAPSHOT (plan step C.4), one read-only query, as CSV with a header,
// and beside it <the snapshot without .csv>.meta.json, written from the same
// read-only REPEATABLE READ transaction:
//   SELECT id, besttime_venue_id, google_place_id, name, latitude::text AS latitude, longitude::text AS longitude,
//       city, besttime_status, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
//     FROM ml_venues ORDER BY id
// (SNAPSHOT_QUERY: the meta's query must be this text, spacing aside). The
// meta holds table, query, isolation, snapshotAt, tableCount, tableMinId and
// tableMaxId (COUNT, MIN and MAX over the whole table in that transaction),
// rowsWritten, firstId, lastId and csvSha256. Nothing in a CSV says it is the
// whole of ml_venues, and the export cannot show it either: a corpus venue
// with no labelled rows is in neither export file. So --write and --parity
// refuse a snapshot unless its meta is there and says so: its query is
// SNAPSHOT_QUERY (no WHERE, no LIMIT), its isolation REPEATABLE READ READ
// ONLY, the CSV's SHA-256 is its csvSha256, the CSV's header is the query's
// columns, the rows read are its tableCount and rowsWritten, and the ids run
// unique and ascending from tableMinId to tableMaxId. A --dry-run takes a
// snapshot without a meta and prints that its completeness is unproven; a
// meta that disagrees is refused in every mode. The import reads the first
// seven columns; --parity needs the last two as well and refuses a snapshot
// without them. Take it after the harvest-inclusive export has finished:
// --write also refuses a snapshot that lacks any venue the export holds.
//
// MEMORY. A full dry run over the 185 folders holds every city's venues until
// the global pass, then about 330k kept weeks of 168 bytes each. Measured
// 2026-11-25 with --harvest-cache, under Node 25's default 4,288 MB heap:
// 143 s, peak resident 1,890 MB, 371 MB of heap at the end; with the snapshot
// (228,214 rows) and the 5.3 GB export as well, 260 s, 2,125 MB and 591 MB.
// The first version kept 168 cell objects per venue and ran out of that heap;
// if a run ever does again, `node --max-old-space-size=12288` is the
// stopgap, never a smaller cache.
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
//   * THE CACHER'S INVENTORY: the replay reproduces the counts progress.json
//     kept for the city, each counted by the cacher's own rules
//     (tools/cacheEverything.cjs): the questions it asked (requests +
//     cachedPages; its run retried nothing, throttled and networkErrors 0,
//     so a request is a question), the records listed (results), distinct
//     venue ids, tiles, splits, leaves, boxes cut at the cap, and records
//     naming another day. A box whose answers are gone together with every
//     question below it (a saturated box and its quarters) leaves no unread
//     file and adds only its own misses, which can equal 404s the subtree
//     held; only these counts show it. Refused as inventoryMismatch, naming
//     each count; noInventory when a count is missing or retries make
//     requests not questions. All 184 accepted November cities reproduce
//     every count exactly (macau does not: 25 questions to its 9);
//   * no record named a day other than the one asked, and no weekday's
//     records all left the day out (checkMarketDays): refused as dayCheck;
//     nor did any one record leave it out (neither day_int nor
//     day_info.day_int): refused as recordsWithoutDay, since beside another
//     venue's record that names the day it passes checkMarketDays and its
//     venue loses that day's 24 rows. No accepted November city has one;
//   * the replay ran to its end (an answer with no venue list stops it):
//     refused as replayAbort, with the harvester's message;
//   * no record was malformed (no venue id, or no 24-hour curve) and no box
//     reached the 500 cap at the smallest tile (venues there were never
//     listed): the counts are printed for every city, accepted or not;
//   * every record of every answer read, as it stands in the file (before
//     duplicates and other days' records are set aside), carries a 24-slot
//     curve, and every slot is a finite number from 0 to 100 (readHours would
//     make any other value a hole: a row missing, with nothing counted):
//     refused as invalidCurveShapes and invalidCurveValues, naming the city,
//     the file, the record, the day and the slot. Every record of the
//     November caches holds 24 whole numbers from 0 to 100 (2,649,365 records,
//     63,584,760 slots in the accepted cities' answers);
//   * no box's paging ended below the venues_n any of its pages declared (on
//     a short page, or a question with no answer): refused as
//     shortPageBelowTotal, naming the day, the page and the counts. Every
//     answer of the November caches carries venues_n equal to its own page's
//     length;
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
// map, the name, the signal and the twin rule, as a harvest's new venues (the
// near-duplicate, twin and 2 km searches read every grid cell their distance
// can reach on kmBetween's sphere, at any latitude and across the
// antimeridian: harvestVenueFilter's GRID SEARCHES). The
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
// identity rules and the 2 km rule are only as good as the snapshot. Its meta
// shows it is the whole table (THE SNAPSHOT); the export shows it is current
// and from the right database: every venue id either export file holds must
// be a snapshot row (a snapshot older than the export, or another
// database's, is refused), neither file may hold a cache row already (an id
// from SYNTHETIC_ID_BASE, or city world_cache), and the 2 km rule also reads the
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
// --accept-peak-flags names it; the dry run says which and how far. A city's
// bar or nightclub comparison the reference cannot make (no readable
// harvest-cache answer for a venue of that category placed in a training
// city: an empty, unreadable or partial --harvest-cache) is UNAVAILABLE,
// printed and reported as such, never as passed, and --write refuses while
// any accepted city has one, unless that city has no venue of the category.
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
// counted apart, by why, never as mismatches. A weekly cell of a compared
// venue (venue, day, hour) that the export holds twice is a mismatch,
// duplicateExportRow, and only its first row is compared. Exit 0 only when
// every compared row matches, no cell is held twice, and neither side has a
// weekly row the other lacks. The snapshot needs its meta here too. What
// created_at alone cannot show: a row another writer (the other pass, a venue
// search) created after this folder's last answer for the venue. So
// --written-before=<instant> (required) bounds it: a venue is compared only
// if its row was also created before that instant, and one created at or
// after it is counted apart (writtenByALaterWriter), never as a mismatch. Set
// it to the start of the next writer for those cities: the next pass's first
// answer (the earliest fetchedAt in its folder) or the venue search's first
// write there (the earliest created_at of a row a search run lists), whichever
// came first. The November bounds: london-2026-11 2026-11-20T00:00:00Z (a
// venue search wrote two of its venues on 11-20, the 40 km pass 265 on
// 11-22); nyc-2026-11 2026-11-20T07:45:21.034Z and austin-2026-11
// 2026-11-20T08:42:48.996Z, the venue searches' first rows in those cities
// (they wrote 427 nyc and 21 austin venues before each 40 km pass began). The
// nyc folder's own resumed run (2026-11-20 15:00 to 17:59) falls after its
// bound, so its 8,486 venues are counted apart, not compared.
//
// And the proof is checked against more than the answers that survive:
//   * --expect-misses (required) is the 404s the run that filled the folder
//     met, and the replay must find exactly that many questions unanswered;
//   * the replay's damage counts must all be 0: malformed records, records
//     naming no day, records without a 24-slot curve, curve slots no number
//     from 0 to 100, boxes ended below their venues_n, boxes cut at the cap,
//     unread files;
//   * THE WRITES THE SNAPSHOT SHOWS: every row of the run's cities stored
//     'harvested' and created from the folder's first answer until the
//     bound, taken from the snapshot alone, must be compared, or found by
//     the replay and left out because its row predates an answer here that
//     lists it (within the bound only this folder's runs wrote, so that is a
//     venue an earlier run of the folder wrote and a later run listed again,
//     whose answers cannot be told apart). Any other is NOT REPRODUCED and
//     fails the proof: a venue whose every answer is gone is in no answer
//     here (inNoAnswerHere), and one the replay plans otherwise than the
//     harvest did is named with the replay's reason.
//
// THE FEEDBACK SNAPSHOT (--feedback-snapshot=<csv>, required by --write): the
// rows say avg_user_crowd 0, user_feedback_count 0, avg_prediction_error 0,
// which is what the exporter writes for a venue with no verified
// venue_feedback report in the 28 days before the row's hour (its LATERAL
// join by google place id). The CSV is FEEDBACK_QUERY's answer, header
// venue_place_id,verified_reports, and beside it <csv without .csv>.meta.json
// from the same read-only REPEATABLE READ transaction, with table, query,
// countQuery (FEEDBACK_COUNT_QUERY), isolation, snapshotAt,
// tableVerifiedCount (that count), rowsWritten, verifiedReportsWritten and
// csvSha256. It is refused unless the table is venue_feedback, the queries
// are FEEDBACK_QUERY and FEEDBACK_COUNT_QUERY (spacing aside), the isolation
// REPEATABLE READ READ ONLY, the CSV's SHA-256 its csvSha256, the meta a
// JSON object, the place ids unique, their count rowsWritten, and the
// reports they sum to both verifiedReportsWritten and tableVerifiedCount
// exactly (venue_place_id is NOT NULL, migration 001, so every verified report
// is in a group; a count above the CSV's is a report left out). --write
// refuses while any kept venue's place id is in it. At the November export the table held no verified report
// (taken 2026-11-25T22:02:43.886Z: 0 of its 6 rows).
//
// OUTPUTS (--write; each refused if it exists): cache_rows.csv (HEADER, then
// the rows; append it to training_data.csv without its first line),
// cache_venues.csv (synthetic id -> city key, BestTime and Google ids, name,
// position, category, days, rows) and cache_manifest.json (inputs, the
// export's files, the snapshot meta's snapshotAt, tableCount and csvSha256
// and the feedback snapshot's included, and outputs with SHA-256s, the git
// commit, every count).
// ---------------------------------------------------------------------------

// NO KEY (see the header), by name only, before anything else is loaded.
const KEY_VARIABLE_RE = /^BESTTIME_API_KEY/i;
const keyVariables = () => Object.keys(process.env).filter((name) => KEY_VARIABLE_RE.test(name)).sort();
const keyRefusal = (names, when) => `REFUSED: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} set ${when}. This `
  + 'import is offline and must never hold a BestTime key: unset it in the shell that runs it. Nothing was read.';
if (require.main === module && keyVariables().length > 0) {
  console.error(`[ML:ImportCache] ${keyRefusal(keyVariables(), 'in the environment')}`);
  process.exit(2);
}

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
// How many of a city's damaged slots or pages a refusal names in full.
const DETAIL_EXAMPLES = 5;
// A bad curve value, described: a number as it is, anything else by its kind
// only, since text from an answer is never printed (logSafe.js).
const valueText = (v) => (typeof v === 'number' ? String(v) : v === null ? 'null'
  : typeof v === 'string' ? `a string of ${v.length} characters` : `a ${Array.isArray(v) ? 'list' : typeof v}`);
// A curve that is not 24 slots, described the same way.
const shapeText = (v) => (v === undefined ? 'no day_raw_whole' : Array.isArray(v) ? `a list of ${v.length}` : valueText(v));
// UTC offsets in use span -12 h to +14 h.
const UTC_OFFSET_MIN_MS = -12 * 3600 * 1000;
const UTC_OFFSET_MAX_MS = 14 * 3600 * 1000;
const SNAPSHOT_COLUMNS = ['id', 'besttime_venue_id', 'google_place_id', 'name', 'latitude', 'longitude', 'city'];
// What --parity needs besides: which venues a harvest wrote, and when.
const PARITY_SNAPSHOT_COLUMNS = ['besttime_status', 'created_at'];
// THE SNAPSHOT's query, as its meta must record it (spacing aside), and the
// header it writes.
const SNAPSHOT_QUERY = 'SELECT id, besttime_venue_id, google_place_id, name, latitude::text AS latitude, '
  + 'longitude::text AS longitude, city, besttime_status,\n    to_char(created_at AT TIME ZONE \'UTC\', '
  + '\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS created_at FROM ml_venues ORDER BY id';
const SNAPSHOT_HEADER = Object.freeze([...SNAPSHOT_COLUMNS, ...PARITY_SNAPSHOT_COLUMNS]);
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
    '--expect-misses=', '--export-dir=', '--written-before=', '--feedback-snapshot='];
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
    'cache-dir', 'export-csv', 'export-dir', 'feedback-snapshot']) {
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
    writtenBefore: null,
    feedbackSnapshot: filePath('feedback-snapshot'),
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
    // An instant with its zone said (Z or an offset), never a local reading.
    const wb = val('written-before');
    if (wb !== null) {
      const at = parseTimestamp(wb);
      if (!Number.isFinite(at)) {
        return { error: '--written-before takes an ISO instant with its zone, e.g. 2026-11-20T00:00:00Z.' };
      }
      opts.writtenBefore = at;
    }
    for (const name of ['cache-root', 'plan', 'progress', 'harvest-cache', 'out-dir', 'accept-peak-flags', 'only', 'export-dir',
      'feedback-snapshot']) {
      if (val(name) !== null) return { error: `--${name} belongs to --dry-run and --write, not --parity.` };
    }
    // Both are what the proof is checked against (--parity in the header).
    if (opts.expectMisses === null) {
      return { error: '--parity needs --expect-misses=<n>, the 404s the run that filled --cache-dir recorded: a miss that was '
        + 'not a 404 is a box whose answers are gone.' };
    }
    if (opts.writtenBefore === null) {
      return { error: '--parity needs --written-before=<instant>, the start of the next writer for these cities (the next '
        + 'pass\'s first answer or the first venue-search run there): every venue the snapshot shows created from this '
        + 'folder\'s first answer until then must be reproduced.' };
    }
    return opts;
  }
  for (const name of ['cache-dir', 'cities', 'radius-km', 'export-csv', 'expect-misses', 'written-before']) {
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
    if (!opts.feedbackSnapshot) {
      return { error: '--write needs --feedback-snapshot: the rows say no verified report exists for any kept venue, and only '
        + 'the snapshot shows it.' };
    }
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
  // Whether the cacher's run ever retried a request (THE CACHER'S INVENTORY):
  // only without a retry are its requests the questions it asked.
  const t = progress.totals;
  const retried = !t || !Number.isInteger(t.throttled) || !Number.isInteger(t.networkErrors) ? null
    : t.throttled > 0 || t.networkErrors > 0;
  const all = [];
  for (const entry of plan) {
    const p = progress.cities[entry.key] || null;
    const city = {
      ...entry, progress: p, dir: null, refused: [], replay: null, opened: false, runRetried: retried,
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
  // The offline checks' findings, the first few in full (harvestVenueFilter's
  // checkOfflineCurves and fetchTile): which file, and what was wrong.
  const invalidShapes = [];
  const invalidCurves = [];
  const shortPages = [];
  let lastFile = null;
  // THE CACHER'S INVENTORY (see the header), counted by its own rules: every
  // record with a venue_id, and every record whose integer day_int is not the
  // day its question asked.
  const inventoryIds = new Set();
  let inventoryOtherDay = 0;
  const ctx = {
    key: H.OFFLINE_KEY, opts, stats: H.emptyStats(), sleep: async () => {}, pace: async () => {},
    city: H.emptyCityStats(tilePlan.length), area: null, dayTally: new Map(), otherDays: new Map(), secrets: [],
    centroids: centroids || undefined, quiet: true,
    // A shape (slot null) and a slot value are listed apart.
    onInvalidCurve: ({ keyless, record, dayInt, slot, value }) => {
      const list = slot === null ? invalidShapes : invalidCurves;
      if (list.length >= DETAIL_EXAMPLES) return;
      list.push({
        file: H.cacheFileName(keyless), record, dayInt: Number.isInteger(dayInt) ? dayInt : null, slot,
        value: slot === null ? shapeText(value) : valueText(value),
      });
    },
    // The box's last answered page is the answer read last: fetchTile judges
    // the box once its paging ends.
    onShortOfTotal: ({ day, page, collected, total, miss }) => {
      if (shortPages.length < DETAIL_EXAMPLES) shortPages.push({ file: lastFile, day, page, collected, venuesN: total, miss });
    },
    onCacheHit: (keyless, entry) => {
      lastFile = H.cacheFileName(keyless);
      read.add(lastFile);
      if (Array.isArray(entry.data.venues)) {
        const asked = Number(new URL(keyless).searchParams.get('day_int'));
        for (const v of entry.data.venues) {
          if (v && v.venue_id) inventoryIds.add(String(v.venue_id));
          if (v && Number.isInteger(v.day_int) && v.day_int !== asked) inventoryOtherDay++;
        }
      }
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
    invalidCurveShapes: s.invalidCurveShapes,
    invalidShapes,
    invalidCurveValues: s.invalidCurveValues,
    invalidCurves,
    shortOfTotal: s.shortOfTotal,
    shortPages,
    venuesFound: [...venues.values()].filter((v) => v.days.size > 0).length,
    fetchedAt: {
      min: Number.isFinite(fetched.min) ? new Date(fetched.min).toISOString() : null,
      max: Number.isFinite(fetched.max) ? new Date(fetched.max).toISOString() : null,
      unreadable: fetched.bad,
    },
    month: Number.isFinite(fetched.min) && fetched.bad === 0 ? monthAcrossZones(fetched.min, fetched.max) : null,
    venueAnswered: answered,
    // What the cacher's progress.json records, as this replay counts it.
    inventory: {
      questions: s.cachedPages + s.cacheMisses, notFound: s.cacheMisses, results: s.cachedResults,
      distinctVenues: inventoryIds.size, tiles: tilePlan.length, splits: s.splits, leaves: ctx.city.leaves,
      truncated: s.truncatedTiles, otherDay: inventoryOtherDay,
    },
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

// THE CACHER'S INVENTORY (see the header): why the replay's counts are not
// progress.json's, as { reason, detail }, or null. notFound is its own rule
// (missesNotNotFound).
const INVENTORY_FIELDS = ['requests', 'cachedPages', 'results', 'distinctVenues', 'tiles', 'splits', 'leaves', 'truncated',
  'otherDay', 'oddAnswers'];
function inventoryRefusal(city, inv) {
  const p = city.progress || {};
  const absent = INVENTORY_FIELDS.filter((f) => !Number.isInteger(p[f]));
  if (absent.length) {
    return { reason: 'noInventory', detail: `progress.json records no ${absent.join(', ')} for it: nothing independent shows `
      + 'the replay asked every question the cacher did' };
  }
  if (city.runRetried !== false || p.oddAnswers > 0) {
    return { reason: 'noInventory', detail: `the cacher's run ${city.runRetried === null ? 'kept no throttled or networkErrors '
      + 'totals' : 'retried requests'}${p.oddAnswers > 0 ? `, and ${p.oddAnswers} odd answers here were asked again` : ''}, `
      + 'so its requests are not the questions it asked' };
  }
  const want = {
    questions: p.requests + p.cachedPages, results: p.results, distinctVenues: p.distinctVenues, tiles: p.tiles,
    splits: p.splits, leaves: p.leaves, truncated: p.truncated, otherDay: p.otherDay,
  };
  const off = Object.keys(want).filter((k) => inv[k] !== want[k]);
  if (off.length === 0) return null;
  const what = { questions: 'questions asked (requests + cachedPages)', results: 'records listed', distinctVenues: 'distinct venue ids',
    tiles: 'tiles', splits: 'splits', leaves: 'leaves', truncated: 'boxes cut at the cap', otherDay: 'records for another day' };
  return {
    reason: 'inventoryMismatch',
    detail: `the replay does not reproduce the cacher's own counts: ${off.map((k) => `${what[k]} ${num(inv[k])}, progress.json `
      + `${num(want[k])}`).join('; ')}. A question whose answers (and every question below them) are gone asks nothing below it, `
      + 'so only the cacher\'s count can show it',
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
  const inventory = inventoryRefusal(city, r.inventory);
  if (inventory) refuse(city, inventory.reason, inventory.detail);
  if (r.malformed > 0) {
    refuse(city, 'malformedRecords', `${r.malformed} records had no venue id or no 24-hour curve: what else the answer `
      + 'left out cannot be told from the file');
  }
  // checkMarketDays refuses a weekday no record named; one venue's record
  // that names none, beside another's that does, is a venue-day set aside
  // with nothing written for it (24 rows gone, the rest of its week kept).
  if (r.unverifiable > 0) {
    refuse(city, 'recordsWithoutDay', `${r.unverifiable} records named no day (neither day_int nor day_info.day_int): each `
      + 'was set aside, and its venue would be written without that day');
  }
  if (r.truncatedTiles > 0) {
    refuse(city, 'truncatedTiles', `${r.truncatedTiles} boxes reached the ${CACHER.resultCap} cap at the smallest tile: `
      + 'venues there were never listed');
  }
  if (r.invalidCurveShapes > 0) {
    refuse(city, 'invalidCurveShapes', `${r.invalidCurveShapes} records carry no 24-slot curve, duplicates and other days' `
      + `records included: ${r.invalidShapes.map((x) => `${city.key} ${x.file} record ${x.record} day_int ${x.dayInt} `
        + `(${x.value})`).join('; ')}${r.invalidCurveShapes > r.invalidShapes.length ? '; ...' : ''}`);
  }
  if (r.invalidCurveValues > 0) {
    refuse(city, 'invalidCurveValues', `${r.invalidCurveValues} curve slots are no number from 0 to 100, each a venue-hour `
      + `that would be left out unseen: ${r.invalidCurves.map((x) => `${city.key} ${x.file} record ${x.record} `
        + `day_int ${x.dayInt} slot ${x.slot} (${x.value})`).join('; ')}${r.invalidCurveValues > r.invalidCurves.length ? '; ...' : ''}`);
  }
  if (r.shortOfTotal > 0) {
    refuse(city, 'shortPageBelowTotal', `${r.shortOfTotal} boxes ended below the venues_n a page of theirs declared, so `
      + `venues there were never read: ${r.shortPages.map((x) => `${city.key} day_int ${x.day}, paging ended at page `
        + `${x.page} (${x.miss ? `no answer file; the last page read was ${x.file}` : x.file}): `
        + `${x.collected} listed in the box, venues_n ${x.venuesN}`).join('; ')}`
      + `${r.shortOfTotal > r.shortPages.length ? '; ...' : ''}`);
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
const KEEP_AWAY_LNG_CELLS = 18000; // 360 / KEEP_AWAY_CELL_DEG, around the globe
const keepAwayLngCell = (lng) => H.wrapCell(Math.floor(lng / KEEP_AWAY_CELL_DEG), KEEP_AWAY_LNG_CELLS);
function keepAwayIndex(rows) {
  const grid = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
    const k = `${Math.floor(r.latitude / KEEP_AWAY_CELL_DEG)}_${keepAwayLngCell(r.longitude)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(r);
  }
  // The nearest row within `km`, or null. The search reaches every cell a
  // point within `km` can be in on kmBetween's own sphere, at any latitude
  // and across the antimeridian (harvestVenueFilter's GRID SEARCHES).
  return (lat, lng, km = CORPUS_KEEP_AWAY_KM) => {
    const gy = Math.floor(lat / KEEP_AWAY_CELL_DEG);
    const reach = H.cellsWithin(lat, km, KEEP_AWAY_CELL_DEG);
    const lngCells = H.lngCellsAround(keepAwayLngCell(lng), reach.lng, KEEP_AWAY_LNG_CELLS);
    let best = null;
    for (let y = gy - reach.lat; y <= gy + reach.lat; y++) {
      for (const x of lngCells) {
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

// The snapshot's meta, beside it (THE SNAPSHOT in the header).
const snapshotMetaFile = (file) => `${file.replace(/\.csv$/i, '')}.meta.json`;
const sameQuery = (a, b) => typeof a === 'string' && a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

// What the meta proves of the parsed snapshot: { file, present, snapshotAt,
// tableCount, csvSha256, problems }, problems empty when it proves the CSV is
// the whole table as SNAPSHOT_QUERY read it in one consistent transaction.
function checkSnapshotMeta(s) {
  const file = snapshotMetaFile(s.file);
  if (!fs.existsSync(file)) return { file, present: false, problems: [] };
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { file, present: true, problems: ['it is not JSON'] };
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { file, present: true, problems: ['it is not a JSON object'] };
  const problems = [];
  const need = (ok, why) => { if (!ok) problems.push(why); };
  need(meta.table === 'ml_venues', `its table is ${JSON.stringify(meta.table)}, not ml_venues`);
  need(sameQuery(meta.query, SNAPSHOT_QUERY), 'its query is not SNAPSHOT_QUERY, the whole table with no WHERE or LIMIT');
  need(typeof meta.isolation === 'string' && /REPEATABLE READ/i.test(meta.isolation) && /READ ONLY/i.test(meta.isolation),
    `its isolation ${JSON.stringify(meta.isolation)} is not REPEATABLE READ READ ONLY, so its counts and the CSV may be `
      + 'two moments');
  need(typeof meta.snapshotAt === 'string' && Number.isFinite(Date.parse(meta.snapshotAt)), 'it has no snapshotAt');
  need(meta.csvSha256 === s.sha256, `its csvSha256 ${meta.csvSha256} is not the CSV's ${s.sha256}`);
  need(s.columns.join(',') === SNAPSHOT_HEADER.join(','), `the CSV's header (${s.columns.join(',')}) is not the query's columns`);
  need(Number.isInteger(meta.tableCount) && meta.tableCount === s.rows && meta.rowsWritten === s.rows,
    `the CSV holds ${s.rows} rows; the table held ${meta.tableCount} and ${meta.rowsWritten} were written`);
  need(s.ascending, 'its ids do not run in ascending order');
  need(meta.tableMinId === s.firstId && meta.firstId === s.firstId, `its first id is ${s.firstId}; the table's lowest was `
    + `${meta.tableMinId} (meta firstId ${meta.firstId})`);
  need(meta.tableMaxId === s.lastId && meta.lastId === s.lastId, `its last id is ${s.lastId}; the table's highest was `
    + `${meta.tableMaxId} (meta lastId ${meta.lastId})`);
  return {
    file, present: true, snapshotAt: meta.snapshotAt, tableCount: meta.tableCount, csvSha256: meta.csvSha256, problems,
  };
}

function loadIdentitySnapshot(file) {
  // One read: the bytes hashed are the bytes parsed.
  const bytes = fs.readFileSync(file);
  const records = parseCsv(bytes.toString('utf8'));
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
  let ascending = true;
  for (let k = 1; k < records.length; k++) {
    const f = records[k];
    if (f.length === 1 && f[0] === '') continue; // a trailing blank line
    if (f.length !== head.length) throw new Error(`${file}: record ${k + 1} has ${f.length} fields, the header ${head.length}`);
    const id = Number(f[at.id]);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`${file}: record ${k + 1} has no integer id`);
    if (ids.has(id)) throw new Error(`${file}: id ${id} twice`);
    if (rows.length > 0 && id < rows[rows.length - 1].id) ascending = false;
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
  const snapshot = {
    file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), rows: rows.length, maxId, noPosition, hasStatus,
    hasCreatedAt, columns: head, firstId: rows.length ? rows[0].id : null, lastId: rows.length ? rows[rows.length - 1].id : null,
    ascending, list: rows, ids,
    identities: identitiesOf(rows),
    nearestCorpus: keepAwayIndex(rows),
  };
  snapshot.meta = checkSnapshotMeta(snapshot);
  return snapshot;
}

// Why the snapshot cannot be used, or null. `required` (--write, --parity):
// only a meta that proves it whole will do; otherwise a meta that is there
// must agree, and one that is not leaves completeness unproven.
function snapshotRefusal(snapshot, required) {
  const m = snapshot.meta;
  if (m.present && m.problems.length) {
    return `the snapshot's meta ${m.file} does not prove it is the whole of ml_venues: ${m.problems.join('; ')}. `
      + 'Take it again (plan step C.4).';
  }
  if (!m.present && required) {
    return `no ${path.basename(m.file)} beside the snapshot: nothing shows it is the whole of ml_venues (a corpus venue `
      + 'with no labelled rows is in neither export file). Take it with its meta (plan step C.4).';
  }
  return null;
}

// ---------------------------------------------------------------------------
// THE FEEDBACK SNAPSHOT (--feedback-snapshot; see the header).
// ---------------------------------------------------------------------------
const FEEDBACK_QUERY = 'SELECT venue_place_id, COUNT(*)::int AS verified_reports FROM venue_feedback WHERE verified = true '
  + 'AND venue_place_id IS NOT NULL GROUP BY venue_place_id ORDER BY venue_place_id';
// The count taken in the same transaction (the meta's countQuery).
const FEEDBACK_COUNT_QUERY = 'SELECT COUNT(*) FROM venue_feedback WHERE verified = true';
const FEEDBACK_HEADER = Object.freeze(['venue_place_id', 'verified_reports']);

// The verified reports by Google place id, and what its meta proves: the
// same shape as the ml_venues snapshot's (problems empty when the CSV is
// FEEDBACK_QUERY's whole answer from one consistent transaction).
function loadFeedbackSnapshot(file) {
  const bytes = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const records = parseCsv(bytes.toString('utf8')).filter((f) => !(f.length === 1 && f[0] === ''));
  const problems = [];
  const head = records.length ? records[0].map((h) => h.trim()) : [];
  if (head.join(',') !== FEEDBACK_HEADER.join(',')) problems.push(`the CSV's header (${head.join(',')}) is not ${FEEDBACK_HEADER.join(',')}`);
  const reports = new Map();
  for (let k = 1; k < records.length; k++) {
    const [placeId, n] = records[k];
    if (records[k].length !== 2 || !placeId || !/^[1-9]\d*$/.test(n || '')) {
      problems.push(`record ${k + 1} is not a place id and a positive count`);
      break;
    }
    if (reports.has(placeId)) { problems.push(`place id ${placeId} twice`); break; }
    reports.set(placeId, Number(n));
  }
  const total = [...reports.values()].reduce((a, b) => a + b, 0);
  const metaFile = snapshotMetaFile(file);
  const meta = { file: metaFile, present: fs.existsSync(metaFile), problems };
  if (meta.present) {
    let m;
    let parsed = false;
    try {
      m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      parsed = true;
    } catch {
      problems.push('its meta is not JSON');
    }
    // null, false, a string, a number or a list proves nothing either.
    if (parsed && (m === null || typeof m !== 'object' || Array.isArray(m))) problems.push('its meta is not a JSON object');
    else if (parsed) {
      const need = (ok, why) => { if (!ok) problems.push(why); };
      need(m.table === 'venue_feedback', `its table is ${JSON.stringify(m.table)}, not venue_feedback`);
      need(sameQuery(m.query, FEEDBACK_QUERY), 'its query is not FEEDBACK_QUERY, every verified report with a place id');
      need(sameQuery(m.countQuery, FEEDBACK_COUNT_QUERY), 'its countQuery is not FEEDBACK_COUNT_QUERY, every verified report');
      need(m.verifiedReportsWritten === total, `the CSV counts ${total} reports; ${m.verifiedReportsWritten} were written`);
      need(typeof m.isolation === 'string' && /REPEATABLE READ/i.test(m.isolation) && /READ ONLY/i.test(m.isolation),
        `its isolation ${JSON.stringify(m.isolation)} is not REPEATABLE READ READ ONLY`);
      need(typeof m.snapshotAt === 'string' && Number.isFinite(Date.parse(m.snapshotAt)), 'it has no snapshotAt');
      need(m.csvSha256 === sha256, `its csvSha256 ${m.csvSha256} is not the CSV's ${sha256}`);
      need(m.rowsWritten === reports.size, `the CSV holds ${reports.size} place ids; ${m.rowsWritten} were written`);
      // Exactly: venue_place_id is NOT NULL (migration 001, never altered),
      // so every verified report is in a group, and a count above the CSV's
      // is a report the CSV left out.
      need(Number.isInteger(m.tableVerifiedCount) && m.tableVerifiedCount === total,
        `the table held ${m.tableVerifiedCount} verified reports; the CSV counts ${total}`);
      Object.assign(meta, { snapshotAt: m.snapshotAt, tableVerifiedCount: m.tableVerifiedCount, csvSha256: m.csvSha256 });
    }
  }
  return { file, sha256, placeIds: reports.size, reports, verifiedReports: total, meta };
}

// Why the feedback snapshot cannot be used, or null; `required` for --write.
function feedbackRefusal(fb, required) {
  if (!fb) return required ? '--write needs the feedback snapshot.' : null;
  const m = fb.meta;
  if (m.problems.length) {
    return `the feedback snapshot ${fb.file} does not prove it holds every verified venue_feedback report: `
      + `${m.problems.join('; ')}. Take it again.`;
  }
  if (!m.present && required) {
    return `no ${path.basename(m.file)} beside the feedback snapshot: nothing shows it holds every verified report.`;
  }
  return null;
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
// PEAK_FLAG_CATEGORIES mode moves PEAK_SHIFT_FLAG_HOURS or more. `unavailable`
// names the PEAK_FLAG_CATEGORIES the city has venues of and the reference
// has no mode for: a comparison not made, never one passed.
function comparePeaks(hist, reference) {
  const out = {};
  let flagged = false;
  const unavailable = [];
  for (const [category, h] of [...hist.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const { n, mode } = histogramMode(h);
    if (mode === null) continue;
    const ref = reference && reference.pooled.get(category) ? histogramMode(reference.pooled.get(category)).mode : null;
    const shift = ref === null ? null : hourShift(ref, mode);
    const flag = PEAK_FLAG_CATEGORIES.includes(category) && shift !== null && Math.abs(shift) >= PEAK_SHIFT_FLAG_HOURS;
    if (flag) flagged = true;
    if (PEAK_FLAG_CATEGORIES.includes(category) && ref === null) unavailable.push(category);
    out[category] = { n, mode, reference: ref, shift, flag };
  }
  return { categories: out, flagged, unavailable };
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
    const none = peaks.unavailable.includes(category) ? ' NO REFERENCE' : '';
    return `${category} ${String(p.mode).padStart(2, '0')}h n=${p.n}${shift}${p.flag ? ' FLAG' : ''}${none}`;
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
    const why = snapshotRefusal(snapshot, opts.mode === 'write');
    if (why) {
      log(`${TAG} REFUSED: ${why} Nothing was replayed${opts.mode === 'write' ? ' or written' : ''}.`);
      return { exitCode: 1, refused: why };
    }
    const m = snapshot.meta;
    log(m.present
      ? `${TAG} SNAPSHOT META: ${m.file}: taken ${m.snapshotAt} in one REPEATABLE READ READ ONLY transaction; the table held `
        + `${num(m.tableCount)} rows, ids ${num(snapshot.firstId)} to ${num(snapshot.lastId)}, every one in the CSV, whose `
        + 'SHA-256 is the one recorded: the snapshot is the whole of ml_venues.'
      : `${TAG} SNAPSHOT META: none (${m.file}), so the snapshot's COMPLETENESS IS UNPROVEN: a corpus venue it lacks `
        + 'would pass the identity and 2 km rules here. --write refuses without it.');
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
  // THE FEEDBACK SNAPSHOT, before any folder is replayed too.
  let feedback = null;
  if (opts.feedbackSnapshot) {
    feedback = loadFeedbackSnapshot(opts.feedbackSnapshot);
    const why = feedbackRefusal(feedback, opts.mode === 'write');
    if (why) {
      log(`${TAG} REFUSED: ${why} Nothing was replayed${opts.mode === 'write' ? ' or written' : ''}.`);
      return { exitCode: 1, refused: why };
    }
    log(`${TAG} FEEDBACK SNAPSHOT: ${opts.feedbackSnapshot}, ${num(feedback.verifiedReports)} verified reports for `
      + `${num(feedback.placeIds)} place ids${feedback.meta.present ? `, taken ${feedback.meta.snapshotAt} in one REPEATABLE READ `
        + `READ ONLY transaction with ${num(feedback.meta.tableVerifiedCount)} verified reports in the table` : ': NO META, so '
        + 'whether it holds every verified report is UNPROVEN'}. A kept venue with any is reported below.`);
  } else {
    log(`${TAG} FEEDBACK SNAPSHOT: none given, so the rows' feedback columns (0, 0, 0) are UNPROVEN; --write refuses without it.`);
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
    + 'boxes cut at the cap, stray files, records with no 24-slot curve, curve slots no number from 0 to 100, boxes ended '
    + 'below their venues_n; drops; '
    + `peak hour per category (mode, venues, hours from the training mode${reference ? '' : ': not run'}).`);
  const records = (r) => ({
    malformed: r.malformed, unverifiable: r.unverifiable, truncatedTiles: r.truncatedTiles, strayFiles: r.strayFiles,
    invalidCurveShapes: r.invalidCurveShapes, invalidCurveValues: r.invalidCurveValues, shortOfTotal: r.shortOfTotal,
  });
  const recordText = (r) => `malformed ${r.malformed}  no day ${num(r.unverifiable)}  cut ${r.truncatedTiles}  stray ${r.strayFiles}`
    + `  bad curves ${r.invalidCurveShapes}  bad slots ${r.invalidCurveValues}  short of total ${r.shortOfTotal}`;
  // The bar and nightclub comparisons the reference could not make, by city.
  const peakUnavailable = {};
  for (const city of [...accepted].sort((a, b) => a.key.localeCompare(b.key))) {
    const r = city.replay;
    const kept = keptByCity.get(city.key);
    const rows = kept.reduce((n, k) => n + k.rows, 0);
    const hist = peakHistogramOfWeeks(kept);
    const peaks = comparePeaks(hist, reference);
    if (peaks.flagged) flagged.push(city.key);
    if (reference && peaks.unavailable.length) peakUnavailable[city.key] = peaks.unavailable;
    const drops = pass.drops.get(city.key);
    report.cities[city.key] = {
      state: 'accepted', radiusKm: city.radiusKm, filesHeld: r.filesHeld, filesRead: r.filesRead, misses: r.misses,
      notFound: city.notFound, venuesFound: r.venuesFound, homeVenues: pass.homeCount.get(city.key) || 0, kept: kept.length,
      incompleteWeeks: kept.filter((k) => k.daysHeld < 7).length, rows, drops, month: r.month, ...records(r),
      fetchedAt: r.fetchedAt, peaks: reference ? peaks.categories : null, peakFlag: reference ? peaks.flagged : null,
      peakUnavailable: reference ? peaks.unavailable : null,
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
  // A kept venue the exporter would find verified reports for (THE FEEDBACK
  // SNAPSHOT): its rows' 0, 0, 0 would be wrong.
  const keptWithReports = feedback ? pass.kept.filter((k) => k.venue.placeId && feedback.reports.has(k.venue.placeId)) : [];
  const recordTotals = {
    malformed: 0, unverifiable: 0, truncatedTiles: 0, strayFiles: 0, invalidCurveShapes: 0, invalidCurveValues: 0, shortOfTotal: 0,
  };
  for (const city of accepted) for (const k of Object.keys(recordTotals)) recordTotals[k] += city.replay[k];
  const unavailableCount = Object.values(peakUnavailable).reduce((n, cats) => n + cats.length, 0);
  report.totals = {
    citiesInPlan: plan.length, cacheCities: cities.cacheCities.length, accepted: accepted.length,
    refused: refusedList.length, refusedCacheCities: refusedWithData.length, unreached: unreached.length,
    distinctVenues: pass.distinct, venuesInTwoCircles: pass.inTwoCircles, daysFilledFromAnotherCity: pass.daysFilled,
    kept: pass.kept.length, rows: rowsAll, drops: totalDrops, placedInTrainingCity: pass.trainingPlaced,
    keptWithin80kmOfHoldoutOrBeijing: keptNearHoldout,
    acceptedRecords: recordTotals,
    identityRules: snapshot ? 'applied' : 'pending snapshot',
    keepAwayRule: snapshot ? (exported ? 'applied (snapshot and export)' : 'applied (snapshot only)') : 'pending snapshot',
    feedback: feedback ? {
      snapshot: feedback.file, proven: feedback.meta.present, verifiedReports: feedback.verifiedReports,
      placeIds: feedback.placeIds, keptWithReports: keptWithReports.length,
      firstKeptWithReports: keptWithReports.slice(0, 10).map((k) => k.venue.placeId),
    } : null,
    snapshotCompleteness: !snapshot ? null : snapshot.meta.present
      ? { proven: true, meta: snapshot.meta.file, snapshotAt: snapshot.meta.snapshotAt, tableCount: snapshot.meta.tableCount }
      : { proven: false, meta: null },
    exportChecked: exported ? exported.files.map((f) => ({ file: f.file, sha256: f.sha256, rows: f.rows })) : null,
    peakCheck: !reference ? 'not run'
      : unavailableCount ? `run, ${unavailableCount} bar or nightclub comparisons unavailable` : 'run',
    peakUnavailable: reference ? peakUnavailable : null,
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
  log(feedback
    ? `${TAG} FEEDBACK: ${num(keptWithReports.length)} kept venues have a verified report in the feedback snapshot`
      + `${keptWithReports.length ? ` (first ${t.feedback.firstKeptWithReports.join(', ')}); their rows' feedback columns `
        + 'would not be 0, and --write refuses' : ''}.`
    : `${TAG} FEEDBACK: not checked (no --feedback-snapshot).`);
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
    // Not flagged is not passed: a comparison the reference cannot make.
    log(`${TAG} PEAK COMPARISONS UNAVAILABLE (${unavailableCount}; the training reference has no venue of the category, `
      + `--write refuses while any is listed): ${Object.entries(peakUnavailable).map(([k, cats]) => `${k} (${cats.join(', ')})`)
        .join('; ') || 'none'}.`);
  }

  const result = { exitCode: 0, report, kept: pass.kept, flagged, snapshot, exported, reference, feedback, started };
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
  const unproven = snapshotRefusal(result.snapshot, true);
  if (unproven) return fail(unproven);
  const noFeedback = feedbackRefusal(result.feedback, true);
  if (noFeedback) return fail(noFeedback);
  const withReports = result.report.totals.feedback.keptWithReports;
  if (withReports > 0) {
    return fail(`${withReports} kept venues have verified venue_feedback reports (first place ids `
      + `${result.report.totals.feedback.firstKeptWithReports.join(', ')}): the exporter would give their rows the reports' `
      + 'averages, and these rows say 0, 0, 0.');
  }
  if (!result.reference) return fail('--write needs the peak-hour check\'s training reference (--harvest-cache).');
  const unavailable = Object.entries(result.report.totals.peakUnavailable || {});
  if (unavailable.length) {
    const ref = result.reference;
    return fail(`the peak-hour check could not compare ${unavailable.map(([k, cats]) => `${k} (${cats.join(', ')})`).join('; ')}: `
      + `the training reference (${ref.dir}: ${num(ref.files)} answers, ${ref.unreadable} unreadable, ${num(ref.venues)} venues `
      + 'placed in a training city) has no venue of that category, so a city whose axis is off there would pass unseen.');
  }
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
      identitySnapshot: {
        file: result.snapshot.file, sha256: result.snapshot.sha256, rows: result.snapshot.rows,
        meta: {
          file: result.snapshot.meta.file, snapshotAt: result.snapshot.meta.snapshotAt, tableCount: result.snapshot.meta.tableCount,
          csvSha256: result.snapshot.meta.csvSha256,
        },
      },
      export: {
        dir: result.exported.dir,
        files: result.exported.files.map((f) => ({ file: path.basename(f.file), sha256: f.sha256, rows: f.rows })),
        venues: result.exported.venues.size,
        note: 'every venue id here is a snapshot row; the 2 km rule read these positions too',
      },
      harvestCache: {
        dir: result.reference.dir, files: result.reference.files, unreadable: result.reference.unreadable, venues: result.reference.venues,
      },
      feedbackSnapshot: {
        file: result.feedback.file, sha256: result.feedback.sha256, placeIds: result.feedback.placeIds,
        verifiedReports: result.feedback.verifiedReports, keptWithReports: 0,
        meta: {
          file: result.feedback.meta.file, snapshotAt: result.feedback.meta.snapshotAt,
          tableVerifiedCount: result.feedback.meta.tableVerifiedCount, csvSha256: result.feedback.meta.csvSha256,
        },
      },
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
function parityVenues(r, snapshot, cities, radiusKm, writtenBefore = null) {
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
    writtenByALaterWriter: 0, // its row is from --written-before or later: the next writer's
    noCreatedAt: 0,
    notPlannedNew: 0, // skipped by the replay's own rules (radius, type, name, signal, twins, claims)
  };
  const planned = new Set();
  // Why each venue the replay found is not compared, by BestTime id.
  const whyLeft = new Map();
  const leave = (venueId, why) => { left[why]++; whyLeft.set(venueId, why); };
  for (const item of plan) {
    const id = item.venue.venueId;
    planned.add(id);
    if (item.kind !== 'new') { leave(id, 'heldBeforeFirstAnswer'); continue; }
    const stored = snapshot.identities.byBtId.get(id);
    if (!stored) { leave(id, 'neverWritten'); continue; }
    if (stored.besttime_status !== H.HARVEST_STATUS) { leave(id, 'storedUnderAnotherStatus'); continue; }
    if (stored.createdAtMs === null) { leave(id, 'noCreatedAt'); continue; }
    const lastAnswer = r.venueAnswered.get(id);
    if (!(stored.createdAtMs >= lastAnswer)) { leave(id, 'writtenBeforeItsAnswerHere'); continue; }
    if (writtenBefore !== null && !(stored.createdAtMs < writtenBefore)) { leave(id, 'writtenByALaterWriter'); continue; }
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
    if (!planned.has(v.venueId)) leave(v.venueId, 'notPlannedNew');
    const stored = snapshot.identities.byBtId.get(v.venueId);
    if (stored && stored.besttime_status === H.HARVEST_STATUS && !expected.has(stored.id)) harvestedElsewhere++;
  }
  return { expected, left, harvestedElsewhere, t0, whyLeft };
}

// THE WRITES THE SNAPSHOT SHOWS (--parity in the header), from the snapshot
// alone: every row of the run's cities stored 'harvested' and created from
// the folder's first answer until --written-before. Each must be compared,
// or found by the replay and left out because its row predates an answer
// here that lists it (writtenBeforeItsAnswerHere: within the bound only this
// folder's runs wrote, so an earlier run wrote it and a later run listed it
// again, and which answers wrote it cannot be told); anything else is a
// write the replay does not reproduce.
function unreproducedWrites(snapshot, cities, t0, writtenBefore, expected, whyLeft) {
  const out = { candidates: 0, compared: 0, justified: 0, unreproduced: [] };
  for (const row of snapshot.list) {
    if (!cities.includes(row.city) || row.besttime_status !== H.HARVEST_STATUS || row.createdAtMs === null) continue;
    if (!(row.createdAtMs >= t0 && row.createdAtMs < writtenBefore)) continue;
    out.candidates++;
    if (expected.has(row.id)) { out.compared++; continue; }
    const why = row.besttime_venue_id ? whyLeft.get(row.besttime_venue_id) : null;
    if (why === 'writtenBeforeItsAnswerHere') { out.justified++; continue; }
    out.unreproduced.push({ id: row.id, btId: row.besttime_venue_id, why: why || 'inNoAnswerHere' });
  }
  return out;
}

async function runParity(opts, { log }) {
  const snapshot = loadIdentitySnapshot(opts.identitySnapshot);
  const lacking = PARITY_SNAPSHOT_COLUMNS.filter((c) => !snapshot.columns.includes(c));
  if (lacking.length) {
    log(`${TAG} PARITY REFUSED: the snapshot lacks ${lacking.join(' and ')}, so which venues this folder's runs wrote `
      + 'cannot be told from those another pass wrote (see THE SNAPSHOT in the header).');
    return { exitCode: 1 };
  }
  const unproven = snapshotRefusal(snapshot, true);
  if (unproven) {
    log(`${TAG} PARITY REFUSED: ${unproven}`);
    return { exitCode: 1, refused: unproven };
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
  // A folder with damaged answers proves nothing about the rows it wrote.
  const damage = {
    malformed: r.malformed, 'records naming no day': r.unverifiable, 'records without a 24-slot curve': r.invalidCurveShapes,
    'curve slots no number 0 to 100':
      r.invalidCurveValues, 'boxes ended below their venues_n': r.shortOfTotal, 'boxes cut at the cap': r.truncatedTiles,
    'unread files': r.filesUnread.length,
  };
  const damaged = Object.entries(damage).filter(([, n]) => n > 0);
  if (damaged.length) {
    const why = `the folder's answers are damaged: ${damaged.map(([k, n]) => `${k} ${num(n)}`).join(', ')}.`;
    log(`${TAG} PARITY REFUSED: ${why}`);
    return { exitCode: 1, refused: why, damage };
  }
  const { expected, left, harvestedElsewhere, t0, whyLeft } = parityVenues(r, snapshot, opts.cities, opts.radiusKm,
    opts.writtenBefore);
  const bound = opts.writtenBefore === null ? '' : ` and before ${new Date(opts.writtenBefore).toISOString()} (--written-before)`;
  log(`${TAG} PARITY: ${num(expected.size)} venues this folder's runs wrote to compare (planned new against the corpus `
    + `before ${r.fetchedAt.min}, stored 'harvested', created after every answer here that lists them${bound}). Left out: `
    + `${dropText(left) || 'none'}. Of those, ${num(harvestedElsewhere)} are stored 'harvested' from another pass's answers, `
    + 'never compared.');
  const writes = unreproducedWrites(snapshot, opts.cities, t0, opts.writtenBefore, expected, whyLeft);
  log(`${TAG} PARITY: the snapshot shows ${num(writes.candidates)} venues of ${opts.cities.join(', ')} stored 'harvested' and `
    + `created from ${r.fetchedAt.min} until ${new Date(opts.writtenBefore).toISOString()}: ${num(writes.compared)} compared, `
    + `${num(writes.justified)} found here but written before an answer here that lists them, ${num(writes.unreproduced.length)} `
    + `NOT REPRODUCED${writes.unreproduced.length ? ` (${writes.unreproduced.slice(0, 10).map((w) => `${w.id} ${w.btId} ${w.why}`)
      .join('; ')}${writes.unreproduced.length > 10 ? '; ...' : ''})` : ''}.`);
  const header = HEADER_FIELDS;
  // A column's count of rows that differ, and duplicateExportRow: a compared
  // venue's weekly cell the export holds more than once.
  const mismatches = { ...Object.fromEntries(header.map((h) => [h, 0])), duplicateExportRow: 0 };
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
    if (exp.seen.has(dow * 24 + hour)) {
      mismatches.duplicateExportRow++;
      if (examples.length < 10) examples.push(`venue ${id} day ${dow} hour ${hour}: the export holds this weekly cell again`);
      continue;
    }
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
  const pass = expected.size > 0 && rowsCompared > 0 && rowsEqual === rowsCompared && missing === 0 && extra === 0
    && mismatches.duplicateExportRow === 0 && writes.unreproduced.length === 0;
  log(`${TAG} PARITY ${pass ? 'PASS' : 'FAIL'}.`);
  return {
    exitCode: pass ? 0 : 1, venues: expected.size, rowsCompared, rowsEqual, missing, extra, nonWeeklySkipped, mismatches,
    examples, left, harvestedElsewhere, writes,
  };
}

// ---------------------------------------------------------------------------
async function run(argv = process.argv, { log = console.log } = {}) {
  // NO KEY, again, now that every module is loaded (see the header).
  const keys = keyVariables();
  if (keys.length > 0) {
    const error = keyRefusal(keys, 'in this process once its modules were loaded');
    log(`${TAG} ${error}`);
    return { exitCode: 2, error };
  }
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
  loadFeedbackSnapshot,
  parityVenues,
  unreproducedWrites,
  snapshotMetaFile,
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
  SNAPSHOT_QUERY,
};

if (require.main === module) {
  run().then((res) => { process.exitCode = res.exitCode; }).catch((err) => {
    console.error(`${TAG} FAILED: ${(err && err.message) || 'unknown error'}`);
    process.exitCode = 1;
  });
}
