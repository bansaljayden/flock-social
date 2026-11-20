// ---------------------------------------------------------------------------
// FILE THE NEW VENUES A BESTTIME VENUE SEARCH FOUND
// ---------------------------------------------------------------------------
// Run (from backend/):
//   node scripts/ml/harvestVenueSearch.js --dir=<search run dir>            dry run
//   node scripts/ml/harvestVenueSearch.js --dir=<search run dir> --commit   writes, once the axis proof passes
//
// WHY THIS EXISTS. The plan's Venue Search allowance (5,000 normal search units
// a calendar month, one unit per 20 results) went unused until 2026-11-19. A
// search looks venues up and forecasts them, so it reaches venues BestTime held
// no forecast for, which the venue filter (harvestVenueFilter.js) therefore
// never lists: of 39 venues a Philadelphia search pilot forecast that the
// corpus did not hold, the filter returned none, asked around each one with
// every venue type. They need their own path into the corpus, and this is it.
//
// WHAT IT READS. Two files a search run wrote into --dir, one JSON object a line:
//   venues.jsonl      every venue a search returned with a forecast: its
//                     BestTime id, name, address, coordinates and the week it
//                     came with (seven days of `day_raw`, 24 slots each);
//   venue_info.jsonl  for each venue the corpus did not hold when the search
//                     ran, BestTime's GET /forecasts/week answer about it: the
//                     venue type, rating and review count (free within a day of
//                     the forecast the search made).
// It makes no request to BestTime or anyone else. It reads those files and the
// database, and writes the database only under --commit.
//
// IDENTITY. A search answer carries no Google place id, but a BestTime venue id
// is one: "ven_" and the hex of the place id written backwards. Measured
// 2026-11-19 on every ml_venues row holding both ids: 119,266 of 120,130 decode
// to the stored place id exactly; the other 864 store a legacy `bt_` pseudo id
// (every one decodes to a real "ChIJ" id). placeIdFromBestTimeId reads it, and
// only an id of Google's shape (harvestVenueFilter.isRealGooglePlaceId) is
// used. From there the venue is planned by harvestVenueFilter.planVenues, the
// filter harvest's own rules in its own order (its header, IDENTITY and WHERE A
// VENUE BELONGS): placed in a training market or skipped, known by BestTime id,
// by place id or as a nearby similar name, or new.
//
// WHAT IT WRITES: NEW VENUES ONLY, as harvestVenueFilter.js --new-only does. A
// known venue's curve from a search is the forecast the corpus already stores
// or the filter refreshes, so nothing is written for it; it feeds the axis
// proof. A new venue gets an inactive ml_venues row (besttime_status
// 'harvested', its category from the venue type through TYPE_TO_CATEGORY, so a
// type that maps to none is skipped) and its typical week, through
// harvestVenueFilter.writeOne: same transaction, lock, re-checks and rows as a
// filter-harvested venue, labelled the same way (collection_mode 'weekly',
// hour_axis 'venue_local', no epoch, a typical week's event stamp).
//
// THE AXIS IS PROVED BEFORE ANYTHING IS WRITTEN, as in the filter harvest: the
// write assumes slot 0 of a search's `day_raw` is 6 AM, as in a forecast's. The
// searches also return venues the corpus holds by BestTime id, and their curves
// are compared with the weekly rows stored for them at every rotation of the
// week; a --commit refuses unless the --new-only rule of axisVerdict passes.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const h = require('./harvestVenueFilter');
const { describeError, describeDbError, safeText } = require('./logSafe');

const TAG = '[ML:SearchHarvest]';

// "ven_" + hex(place id reversed) -> the place id, or null when the id is not
// of that form or does not decode to an id of Google's shape.
function placeIdFromBestTimeId(venueId) {
  const m = /^ven_((?:[0-9a-f]{2})+)$/i.exec(String(venueId || ''));
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'hex').toString('latin1').split('').reverse().join('');
  return h.isRealGooglePlaceId(decoded) ? decoded : null;
}

function readHours(raw) {
  if (!Array.isArray(raw) || raw.length !== 24) return null;
  if (!raw.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return raw.map((v) => Math.max(0, Math.min(100, Math.round(v))));
}

// One venues.jsonl line (and its venue_info.jsonl line, when there is one) in
// the shape harvestVenueFilter.planVenues and writeOne read, or null when the
// week is not seven whole days.
function readSearchVenue(line, info) {
  if (!line || typeof line.venue_id !== 'string' || !line.venue_id.trim()) return null;
  const days = new Map();
  for (const d of Array.isArray(line.days) ? line.days : []) {
    const hours = readHours(d && d.day_raw);
    if (!Number.isInteger(d && d.day_int) || d.day_int < 0 || d.day_int > 6 || !hours || days.has(d.day_int)) return null;
    days.set(d.day_int, hours);
  }
  if (days.size !== 7) return null;
  const venueId = line.venue_id.trim();
  const rating = Number(info && info.rating);
  const reviews = Number(info && info.reviews);
  return {
    venueId,
    placeId: placeIdFromBestTimeId(venueId),
    rawPlaceId: null,
    name: typeof line.name === 'string' ? line.name : '',
    address: typeof line.address === 'string' ? line.address : '',
    lat: Number(line.lat),
    lng: Number(line.lng),
    type: info && typeof info.venue_type === 'string' ? info.venue_type.toUpperCase() : null,
    rating: Number.isFinite(rating) && rating > 0 && rating <= 5 ? rating : null,
    reviews: Number.isInteger(reviews) && reviews > 0 ? reviews : null,
    days,
    altDays: new Map(),
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!text.trim()) continue;
    try { out.push(JSON.parse(text)); } catch { /* a line cut by a stop mid-write */ }
  }
  return out;
}

// Every venue the run's files hold, once each (the first line wins), with the
// counts the summary prints.
function loadSearchDir(dir) {
  const infoById = new Map();
  for (const i of readJsonl(path.join(dir, 'venue_info.jsonl'))) {
    if (i && i.venue_id && i.status === 'OK' && !infoById.has(i.venue_id)) infoById.set(i.venue_id, i);
  }
  const venues = [];
  const seen = new Set();
  const counts = { lines: 0, duplicates: 0, notWholeWeek: 0, withInfo: 0, noPlaceId: 0 };
  for (const line of readJsonl(path.join(dir, 'venues.jsonl'))) {
    counts.lines++;
    if (seen.has(line.venue_id)) { counts.duplicates++; continue; }
    seen.add(line.venue_id);
    const v = readSearchVenue(line, infoById.get(line.venue_id));
    if (!v) { counts.notWholeWeek++; continue; }
    if (infoById.has(v.venueId)) counts.withInfo++;
    if (!v.placeId) counts.noPlaceId++;
    venues.push(v);
  }
  return { venues, counts, infoLines: infoById.size };
}

function parseArgs(argv) {
  const opts = { dir: null, commit: false, radiusKm: h.DEFAULT_RADIUS_KM };
  for (const arg of argv.slice(2)) {
    if (arg === '--commit') opts.commit = true;
    else if (arg.startsWith('--dir=')) opts.dir = arg.slice(6);
    else if (arg.startsWith('--radius-km=')) opts.radiusKm = Number(arg.slice(12));
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.dir) throw new Error('--dir=<search run dir> is required');
  if (!fs.existsSync(path.join(opts.dir, 'venues.jsonl'))) throw new Error(`${opts.dir} holds no venues.jsonl`);
  if (!(opts.radiusKm > 0 && opts.radiusKm <= 40)) throw new Error('--radius-km must be in (0, 40]');
  return opts;
}

async function harvestSearch({ argv, pool }) {
  const opts = parseArgs(argv);
  const summary = {
    exitCode: 1, venues: 0, plan: { known_bt: 0, known_place: 0, known_near: 0, new: 0 },
    rowsPlanned: 0, venuesWritten: 0, venuesInserted: 0, rowsWritten: 0, rowsInserted: 0,
    vanished: 0, claimed: 0, writeFailures: 0,
  };
  const { venues, counts, infoLines } = loadSearchDir(opts.dir);
  summary.venues = venues.length;
  console.log(`${TAG} ${opts.commit ? 'COMMIT' : 'DRY RUN (nothing is written; --commit writes)'}: ${opts.dir}. `
    + `${counts.lines} venue lines, ${counts.duplicates} repeats, ${counts.notWholeWeek} without seven whole days; `
    + `${venues.length} venues, ${counts.withInfo} with a venue type (${infoLines} info answers), `
    + `${counts.noPlaceId} whose BestTime id does not decode to a Google place id. New venues only.`);

  const identities = await h.loadIdentities(pool, venues.map((v) => v.venueId), venues.map((v) => v.placeId).filter(Boolean));
  identities.nearby = await h.loadNearbyRows(pool, venues);
  const { plan, skipped } = h.planVenues(venues, identities, [...h.ALL_CITIES], { radiusKm: opts.radiusKm });
  const writes = [];
  const byCity = new Map();
  for (const item of plan) {
    summary.plan[item.kind]++;
    if (item.kind !== 'new') continue;
    item.cells = h.weekCells([...item.venue.days.entries()].sort((a, b) => a[0] - b[0]));
    writes.push(item);
    summary.rowsPlanned += item.cells.length;
    byCity.set(item.city, (byCity.get(item.city) || 0) + 1);
  }
  console.log(`${TAG} Known by BestTime id: ${summary.plan.known_bt}. Known by Google place id: ${summary.plan.known_place}. `
    + `Known as a near-duplicate of an existing row: ${summary.plan.known_near}. New: ${summary.plan.new}.`);
  console.log(`${TAG} Skipped: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  console.log(`${TAG} New by city: ${[...byCity.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}.`);

  const agree = h.placeIdAgreement(plan);
  console.log(`${TAG} PLACE IDS, venues known by BestTime id: ${agree.same} of ${agree.knownBt} decode to the stored `
    + `google_place_id; ${agree.differs} to a different real one; ${agree.storedPseudo} are stored under a bt_ pseudo id.`);

  // THE AXIS PROOF, before a single row can be written.
  const knownBt = plan.filter((item) => item.kind === 'known_bt');
  const stored = await h.loadStoredWeeks(pool, knownBt.map((item) => Number(item.row.id)));
  const pairs = knownBt
    .filter((item) => stored.has(Number(item.row.id)))
    .map((item) => ({
      planned: h.weekCurve(h.weekCells([...item.venue.days.entries()].sort((a, b) => a[0] - b[0]))),
      stored: stored.get(Number(item.row.id)),
    }));
  const proof = h.axisProof(pairs);
  const verdict = h.axisVerdict(proof, { newOnly: true });
  summary.axis = proof;
  summary.axisVerdict = verdict;
  console.log(`${TAG} AXIS PROOF: ${knownBt.length} venues known by BestTime id, ${stored.size} with stored weekly rows; `
    + `${proof.venues} compared (${proof.thin} thin and ${proof.flat} flat left out). Shift +k: the search's curve sits `
    + 'k hours later on the venue clock than the stored rows.');
  for (const line of h.formatAxisTable(proof)) console.log(line);
  console.log(`${TAG} COMMIT GATE: ${verdict.pass ? 'PASS' : 'REFUSED'} (${verdict.reason}). Judged by ${verdict.rule}.`);
  console.log(`${TAG} PEAK HOUR by category, venue-local, new venues:`);
  for (const line of h.formatPeakHistogram(h.peakHourHistogram(writes))) console.log(line);

  if (!opts.commit) {
    console.log(`${TAG} Would write ${summary.rowsPlanned} weekly rows and add ${writes.length} ml_venues rows `
      + `(inactive, besttime_status '${h.HARVEST_STATUS}').`);
    summary.exitCode = summary.rowsPlanned > 0 && verdict.pass ? 0 : 1;
    return summary;
  }
  if (!verdict.pass) {
    console.error(`${TAG} REFUSED: the axis proof failed, so the curves' hour origin is not established: ${verdict.reason}. Nothing was written.`);
    return summary;
  }
  for (const item of writes) {
    if (item.cells.length === 0) continue;
    try {
      const res = await h.writeOne(pool, item, item.cells);
      if (res.status === 'vanished') { summary.vanished++; continue; }
      if (res.status === 'claimed') { summary.claimed++; continue; }
      summary.venuesWritten++;
      if (res.newVenue) summary.venuesInserted++;
      summary.rowsWritten += res.written;
      summary.rowsInserted += res.inserted;
    } catch (err) {
      summary.writeFailures++;
      console.error(`  write failed for ${safeText(item.venue.venueId)} (${err.code || 'no code'}): ${describeDbError(err)}`);
    }
  }
  console.log(`${TAG} Wrote ${summary.rowsWritten} weekly rows (${summary.rowsInserted} new) for ${summary.venuesWritten} `
    + `venues; added ${summary.venuesInserted} ml_venues rows. ${summary.vanished} changed under the run, `
    + `${summary.claimed} were claimed by another writer, ${summary.writeFailures} writes failed.`);
  summary.exitCode = summary.rowsWritten > 0 && summary.writeFailures === 0 ? 0 : 1;
  return summary;
}

function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
}

async function main(argv = process.argv, deps = {}) {
  const pool = deps.pool || makePool();
  try {
    const summary = await harvestSearch({ argv, pool });
    process.exitCode = summary.exitCode;
    return summary;
  } finally {
    if (!deps.pool) await pool.end();
  }
}

module.exports = { main, harvestSearch, parseArgs, placeIdFromBestTimeId, readSearchVenue, loadSearchDir };

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} Fatal (${(err && err.name) || 'unknown error'}): ${describeError(err)}`);
    process.exitCode = 1;
  });
}
