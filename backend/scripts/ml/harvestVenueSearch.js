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
//                     venue type and the finer types beside it, rating and
//                     review count (free within a day of the forecast the
//                     search made).
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
// 'harvested', its category from the venue type through TYPE_TO_CATEGORY, or
// for a BEER or OTHER venue from its Google types (searchCategory), so a venue
// neither names a category for is skipped) and its typical week, through
// harvestVenueFilter.writeOne: same transaction, lock, re-checks and rows as a
// filter-harvested venue, labelled the same way (collection_mode 'weekly',
// hour_axis 'venue_local', no epoch, a typical week's event stamp).
//
// THE AXIS IS PROVED BEFORE ANYTHING IS WRITTEN, as in the filter harvest: the
// write assumes slot 0 of a search's `day_raw` is 6 AM, as in a forecast's. The
// searches also return venues the corpus holds by BestTime id, and their curves
// are compared with the weekly rows stored for them at every rotation of the
// week; a --commit refuses unless the --new-only rule of axisVerdict passes.
// The reference is only stored rows no search produced: discoverBestTime.js
// once wrote weekly rows from this same search field through this same
// transform, and a proof against those would compare the search with itself
// and pass whatever the axis. loadReferenceWeeks says which rows qualify.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const h = require('./harvestVenueFilter');
const { exactCategoryFor } = require('./addDemandVenues');
const { requireSlotIndex, HOUR_AXIS_VENUE_LOCAL, WEEKLY_SLOT_INDEX } = require('./collectWeekly');
const { requireVenueIdIndex } = require('./discoverBestTime');
const { describeError, describeDbError, safeText } = require('./logSafe');

const TAG = '[ML:SearchHarvest]';
const WEEK_HOURS = 168;

// "ven_" + hex(place id reversed) -> the decoded string, or null when the id is
// not of that form. placeIdFromBestTimeId keeps only a string of Google's shape.
function decodeBestTimeId(venueId) {
  const m = /^ven_((?:[0-9a-f]{2})+)$/i.exec(String(venueId || ''));
  if (!m) return null;
  return Buffer.from(m[1], 'hex').toString('latin1').split('').reverse().join('');
}

function placeIdFromBestTimeId(venueId) {
  const decoded = decodeBestTimeId(venueId);
  return decoded && h.isRealGooglePlaceId(decoded) ? decoded : null;
}

// Just before the first Venue Search request of the runs this script reads
// (2026-11-20 02:01 UTC). No venue created earlier can hold a search answer
// from them, whatever wrote it, and every venue this script writes is created
// later.
const SEARCH_RUNS_BEGAN = '2026-11-20T02:00:00Z';
// The filter harvest's two statuses: a harvested venue, and one promoted out of
// 'harvested' with its rows kept (scripts/ml/RETRAIN.md, the promotion step).
const FILTER_HARVEST_STATUSES = [h.HARVEST_STATUS, 'harvest_measured'];
// When a pseudo `bt_` venue was last created or updated, whatever did it.
// discoverBestTime mints those ids and its upsert bumps updated_at on any venue
// it touches, so a discovery run that reached one is never later than this
// (migration 060 also updates them). NULL when none exist.
const PSEUDO_LAST_SEEN_SQL = `(SELECT GREATEST(MAX(created_at), MAX(updated_at))
     FROM ml_venues WHERE google_place_id LIKE 'bt\\_%' ESCAPE '\\')`;

// The axis proof's reference: per row, the stored weekly venue-local cells that
// no search produced, as weekCurve()s. Two kinds qualify.
//   * A cell that carries a besttime_epoch. collectWeekly stamps it from the
//     forecast it writes, the filter harvest keeps a stamp a row has and never
//     invents one (WEEKLY_UPSERT_CONFLICT), and discoverBestTime.js, the only
//     other writer that took values from the search field, sets it to NULL.
//   * Every cell of a venue the filter harvest created (FILTER_HARVEST_STATUSES)
//     before the search runs began, never updated since, and after a pseudo
//     `bt_` venue was last created or touched. Its week came from the venue
//     filter, and a filter harvest run commits only once its own axis proof
//     passes (one pooled verdict per run). The filter's axis was first settled
//     against collectWeekly's forecasts: on the first dry run (philly,
//     2026-09-28) 216 venues' curves matched their stored forecast rows exactly
//     on 99.6% of 5,184 cells at rotation 0, r 0.999 (harvestVenueFilter.js,
//     THE CURVE IS day_raw_whole). This script writes only venues it creates, after
//     the searches, so it cannot have written one. discoverBestTime upserts
//     every venue it writes rows for with updated_at = NOW() first, so a venue
//     it touched fails the second test. Measured 2026-11-20: all 103,065
//     filter-harvested venues have updated_at at or before created_at
//     (ml_venues has no trigger), the last `bt_` venue was created 2026-04-05
//     and touched 2026-09-05, and the filter harvest's first venue was created
//     2026-09-29.
// The stamp alone was the rule first, and it found nothing: no weekly row in
// production carried an epoch when this was measured (2026-11-20).
async function loadReferenceWeeks(pool, rowIds) {
  const weeks = new Map();
  const { rows: [seen] } = await pool.query(`SELECT ${PSEUDO_LAST_SEEN_SQL} AS last`);
  const pseudoLastSeen = seen && seen.last ? new Date(seen.last) : null;
  if (rowIds.length === 0) return { weeks, stamped: 0, harvested: 0, pseudoLastSeen };
  const { rows: fromFilter } = await pool.query(
    `SELECT id FROM ml_venues
      WHERE id = ANY($1::bigint[])
        AND besttime_status = ANY($2::text[])
        AND created_at < $3::timestamptz
        AND updated_at <= created_at
        AND created_at > COALESCE(${PSEUDO_LAST_SEEN_SQL}, '-infinity'::timestamptz)`,
    [rowIds, FILTER_HARVEST_STATUSES, SEARCH_RUNS_BEGAN]
  );
  const harvestedIds = fromFilter.map((r) => Number(r.id));
  const { rows } = await pool.query(
    `SELECT venue_id, day_of_week, hour, busyness_pct
       FROM ml_training_data
      WHERE venue_id = ANY($1::bigint[])
        AND collection_mode = 'weekly'
        AND hour_axis = '${HOUR_AXIS_VENUE_LOCAL}'
        AND busyness_pct IS NOT NULL
        AND (besttime_epoch IS NOT NULL OR venue_id = ANY($2::bigint[]))`,
    [rowIds, harvestedIds]
  );
  for (const r of rows) {
    const id = Number(r.venue_id);
    if (!weeks.has(id)) weeks.set(id, new Int16Array(WEEK_HOURS).fill(-1));
    if (r.day_of_week >= 0 && r.day_of_week <= 6 && r.hour >= 0 && r.hour <= 23) {
      weeks.get(id)[r.day_of_week * 24 + r.hour] = Math.max(0, Math.min(100, Math.round(Number(r.busyness_pct))));
    }
  }
  const fromHarvest = new Set(harvestedIds);
  const harvested = [...weeks.keys()].filter((id) => fromHarvest.has(id)).length;
  return { weeks, stamped: weeks.size - harvested, harvested, pseudoLastSeen };
}

// A coordinate from a number or a numeric string, NaN for anything else
// (Number(null), Number(' ') and Number([]) are all 0, a real place).
const coordinate = (x) => {
  if (typeof x === 'number') return x;
  if (typeof x === 'string' && x.trim() !== '') return Number(x);
  return NaN;
};

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
    // What the id decoded to, so the planner counts an id that decodes to no
    // Google shape as unusable rather than absent.
    rawPlaceId: decodeBestTimeId(venueId),
    name: typeof line.name === 'string' ? line.name : '',
    address: typeof line.address === 'string' ? line.address : '',
    lat: coordinate(line.lat),
    lng: coordinate(line.lng),
    type: info && typeof info.venue_type === 'string' ? info.venue_type.toUpperCase() : null,
    // The finer Google-style types BestTime lists beside its own ('pub',
    // 'sports_bar', ...), primary first, in their coded form: some arrive as
    // labels ('Bar', 'Fast food restaurant', 'Gas station').
    googleTypes: info && Array.isArray(info.venue_types)
      ? info.venue_types.filter((t) => typeof t === 'string')
        .map((t) => t.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean)
      : [],
    rating: Number.isFinite(rating) && rating > 0 && rating <= 5 ? rating : null,
    reviews: Number.isInteger(reviews) && reviews > 0 ? reviews : null,
    days,
    altDays: new Map(),
  };
}

// BestTime types whose venues are filed by their Google types. BEER holds pubs,
// sports bars and beer halls beside beer shops, and OTHER names nothing. Of the
// 2026-11-20 run's 2,007 venues the corpus did not hold, 449 were BEER and 393
// OTHER; the rule below files 379 and 309 of them (bar 468, restaurant 88,
// cafe 41, nightclub 34, brewery 28, fast food 12, museum 10, and 7 malls,
// entertainment venues and dessert shops between them). Categories come from
// addDemandVenues' map, the one every venue added from the app's own searches
// is filed by, exact matches only, and from a primary type naming a cuisine's
// restaurant; there is no restaurant default, so a beer shop (liquor_store) or
// a venue typed only 'irish_pub' or 'cocktail_bar' is still skipped. In order:
//   * a venue that is also a shop, a shopping centre or a stadium
//     (SHOP_OR_STADIUM_TYPES) is skipped: a supermarket that lists a cafe is
//     not a cafe, nor a shopping centre with a cinema a cinema (on that run it
//     skipped venues the rest of the rule would have filed: 4 listing
//     supermarket, 3 grocery_store, 3 convenience_store, 2 gas_station, 2
//     shopping_center and 1 outlet_mall);
//   * a venue whose primary type is a shop (PRIMARY_SHOP_TYPES or any
//     '_store', such as liquor_store or beer_store) is skipped: a bottle shop
//     that lists a bar is a shop. Further down the list such a type decides
//     nothing, because pubs list them beside pub (Sydney hotels that sell
//     takeaway, London craft-beer pubs). Two of Google's shopping types are
//     left out on purpose: shopping_mall is the app's own mall, and the two
//     venues with 'market' first on the 2026-11-19 and 2026-11-20 runs were
//     food halls. On those runs no venue filed had a shop first;
//   * a BEER venue is never a cafe or a sweet shop (NOT_FOR_BEER): on that run
//     every BEER venue the map filed as a cafe was a pub or a taproom that
//     also listed one ('The Beer Café', a pub with a coffee_shop type);
//   * the first type is Google's primary one (in 425 of that run's 429 lists
//     of three or more, the rest are in alphabetical order), so it decides
//     when it names a category: a McDonald's that also lists coffee_shop is
//     fast food, a casino with a bar a casino, and a restaurant, or any
//     cuisine's ('french_restaurant'; 'dessert_restaurant' is dessert), a
//     restaurant, whatever else it lists (a Chili's that lists a bar, a
//     Cheesecake Factory a dessert shop, a brewpub restaurant a brewery). One
//     exception, deliberately the only one, keeps the map's ranking, which
//     puts night_club first: a bar or pub that also lists night_club is a
//     nightclub. A BEER venue's first type is passed over when it is one of
//     NOT_FOR_BEER;
//   * otherwise the map's own order over all of them.
// Against the map's order alone, the second and third rules give 46 of that
// run's venues a different category (28 become restaurants, 8 BEER 'cafes'
// bars and 3 McDonald's fast food), and file 21 more, all restaurants of a
// cuisine, that the map names nothing for.
// Any other BestTime type stays with TYPE_TO_CATEGORY alone.
const TYPES_FILED_BY_GOOGLE_TYPES = new Set(['BEER', 'OTHER']);
const SHOP_OR_STADIUM_TYPES = new Set([
  'supermarket', 'grocery_store', 'convenience_store', 'gas_station', 'shopping_center', 'outlet_mall', 'stadium', 'arena',
]);
// The types in Google's Shopping table (place-types, Table A) that do not end
// in '_store', less shopping_mall and market (above). The '_shop' types of its
// Food and Drink table (coffee_shop, juice_shop, pastry_shop) are not shops.
const PRIMARY_SHOP_TYPES = new Set([
  'butcher_shop', 'discount_supermarket', 'farmers_market', 'flea_market', 'garden_center', 'gift_shop',
  'hypermarket', 'store', 'supermarket', 'wholesaler',
]);
const NOT_FOR_BEER = new Set(['cafe', 'coffee_shop', 'bakery', 'ice_cream_shop', 'dessert_shop']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// A new venue's category for planVenues: the BestTime type's, or for BEER and
// OTHER the Google types', or undefined (skipped as unmappedType).
function searchCategory(v) {
  if (typeof v.type === 'string' && own(h.TYPE_TO_CATEGORY, v.type)) return h.TYPE_TO_CATEGORY[v.type];
  if (!TYPES_FILED_BY_GOOGLE_TYPES.has(v.type) || !Array.isArray(v.googleTypes)) return undefined;
  if (v.googleTypes.some((t) => SHOP_OR_STADIUM_TYPES.has(t))) return undefined;
  const first = v.googleTypes[0];
  if (typeof first === 'string' && (first.endsWith('_store') || PRIMARY_SHOP_TYPES.has(first))) return undefined;
  const beer = v.type === 'BEER';
  const types = beer ? v.googleTypes.filter((t) => !NOT_FOR_BEER.has(t)) : v.googleTypes;
  if (typeof first === 'string' && !(beer && NOT_FOR_BEER.has(first))) {
    const primary = exactCategoryFor([first])
      || (first === 'dessert_restaurant' ? 'dessert' : null)
      || (first.endsWith('_restaurant') ? 'restaurant' : null);
    if (primary === 'bar' && v.googleTypes.includes('night_club')) return 'nightclub';
    if (primary) return primary;
  }
  return exactCategoryFor(types) || undefined;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!text.trim()) continue;
    let value;
    try { value = JSON.parse(text); } catch { continue; /* a line cut by a stop mid-write */ }
    if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value);
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
    if (seen.has(typeof line.venue_id === 'string' ? line.venue_id.trim() : line.venue_id)) { counts.duplicates++; continue; }
    const v = readSearchVenue(line, infoById.get(line.venue_id));
    if (!v) { counts.notWholeWeek++; continue; }
    // Marked only once a line was usable, so a later whole line for a venue
    // whose first was not is still read.
    seen.add(v.venueId);
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
  // The filter harvest's two refusals, first: a database whose upsert targets
  // are missing cannot take these writes, and a dry run against it would
  // promise writes it cannot make.
  await requireVenueIdIndex(pool);
  await requireSlotIndex(pool, WEEKLY_SLOT_INDEX);
  const { venues, counts, infoLines } = loadSearchDir(opts.dir);
  summary.venues = venues.length;
  console.log(`${TAG} ${opts.commit ? 'COMMIT' : 'DRY RUN (nothing is written; --commit writes)'}: ${opts.dir}. `
    + `${counts.lines} venue lines, ${counts.duplicates} repeats, ${counts.notWholeWeek} without seven whole days; `
    + `${venues.length} venues, ${counts.withInfo} with a venue type (${infoLines} info answers), `
    + `${counts.noPlaceId} whose BestTime id does not decode to a Google place id. New venues only.`);

  const identities = await h.loadIdentities(pool, venues.map((v) => v.venueId), venues.map((v) => v.placeId).filter(Boolean));
  identities.nearby = await h.loadNearbyRows(pool, venues);
  const { plan, skipped } = h.planVenues(venues, identities, [...h.ALL_CITIES], {
    radiusKm: opts.radiusKm, categoryOf: searchCategory,
  });
  const writes = [];
  const byCity = new Map();
  summary.byGoogleTypes = Object.fromEntries([...TYPES_FILED_BY_GOOGLE_TYPES].map((t) => [t, 0]));
  for (const item of plan) {
    summary.plan[item.kind]++;
    if (item.kind !== 'new') continue;
    item.cells = h.weekCells([...item.venue.days.entries()].sort((a, b) => a[0] - b[0]));
    writes.push(item);
    summary.rowsPlanned += item.cells.length;
    byCity.set(item.city, (byCity.get(item.city) || 0) + 1);
    if (TYPES_FILED_BY_GOOGLE_TYPES.has(item.venue.type)) summary.byGoogleTypes[item.venue.type]++;
  }
  console.log(`${TAG} Known by BestTime id: ${summary.plan.known_bt}. Known by Google place id: ${summary.plan.known_place}. `
    + `Known as a near-duplicate of an existing row: ${summary.plan.known_near}. New: ${summary.plan.new}, of them `
    + `${Object.entries(summary.byGoogleTypes).map(([t, n]) => `${n} ${t}`).join(' and ')} filed by their Google types.`);
  console.log(`${TAG} Skipped: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  console.log(`${TAG} New by city: ${[...byCity.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}.`);

  const agree = h.placeIdAgreement(plan);
  console.log(`${TAG} PLACE IDS, venues known by BestTime id: ${agree.same} of ${agree.knownBt} decode to the stored `
    + `google_place_id; ${agree.differs} to a different real one; ${agree.storedPseudo} are stored under a bt_ pseudo id; `
    + `${agree.filterUnusable} decode to no Google shape; ${agree.filterNone} are not of the encoded form.`);

  // THE AXIS PROOF, before a single row can be written, against stored rows no
  // search produced (loadReferenceWeeks).
  const knownBt = plan.filter((item) => item.kind === 'known_bt');
  const reference = await loadReferenceWeeks(pool, knownBt.map((item) => Number(item.row.id)));
  const stored = reference.weeks;
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
  summary.reference = { stamped: reference.stamped, harvested: reference.harvested, pseudoLastSeen: reference.pseudoLastSeen };
  console.log(`${TAG} AXIS PROOF: ${knownBt.length} venues known by BestTime id, ${stored.size} with reference rows `
    + `(${reference.stamped} by a forecast's epoch, ${reference.harvested} created by the filter harvest; `
    + `a pseudo bt_ venue last created or touched ${reference.pseudoLastSeen ? reference.pseudoLastSeen.toISOString() : 'never'}); `
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

module.exports = {
  main, harvestSearch, parseArgs, decodeBestTimeId, placeIdFromBestTimeId, readSearchVenue, loadSearchDir, loadReferenceWeeks,
  SEARCH_RUNS_BEGAN, FILTER_HARVEST_STATUSES, TYPES_FILED_BY_GOOGLE_TYPES, SHOP_OR_STADIUM_TYPES, PRIMARY_SHOP_TYPES, NOT_FOR_BEER,
  searchCategory,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} Fatal (${(err && err.name) || 'unknown error'}): ${describeError(err)}`);
    process.exitCode = 1;
  });
}
