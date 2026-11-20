// Run: node --test __tests__/harvestVenueSearch.test.js  (from backend/)
//
// scripts/ml/harvestVenueSearch.js files the new venues a BestTime venue search
// found, through harvestVenueFilter's planner, axis proof and writer. Pinned:
//   - a BestTime venue id decodes to the Google place id it encodes, and
//     nothing else decodes;
//   - a search line becomes the venue shape the planner reads, only with seven
//     whole days, and takes its type, rating and reviews from the info line;
//   - the planner keeps known venues out, places venues by market, and skips a
//     new venue whose type maps to no category; a BEER or OTHER venue takes
//     its category from its Google types, exact matches only, and no other
//     type does;
//   - a dry run proves the axis on the known venues and plans the new ones; a
//     --commit whose axis proof fails writes nothing;
//   - the proof's reference is only rows no search produced: forecast-stamped
//     cells, and venues the filter harvest created before the searches began,
//     never updated since, and after the last pseudo `bt_` venue;
//   - the script never makes a network request.
// No database: the pool is a dispatcher over in-memory rows.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const s = require('../scripts/ml/harvestVenueSearch');
const h = require('../scripts/ml/harvestVenueFilter');

const reverse = (x) => x.split('').reverse().join('');
const btIdOf = (placeId) => `ven_${Buffer.from(reverse(placeId), 'latin1').toString('hex')}`;
const placeId = (n) => `ChIJ${String(n).padStart(6, '0')}AbCdEfGhIjKlMn_x`;

test('a BestTime venue id decodes to the Google place id it encodes', () => {
  // A real pair, from the 2026-11-19 search pilot (Pearl's on the Corner).
  assert.strictEqual(
    s.placeIdFromBestTimeId('ven_49396e6235597043646445526b6f784a5058446a6757374a496843'),
    'ChIJ7WgjDXPJxokREddCpY5bn9I'
  );
  assert.strictEqual(s.placeIdFromBestTimeId(btIdOf(placeId(7))), placeId(7));
});

test('only an id of the encoded form and of Google\'s shape decodes', () => {
  for (const bad of [null, '', 'ven_', 'ven_abc', 'ven_zz', 'bt_ven_4d37', placeId(1),
    btIdOf('EiAddressNotAVenue12345678'), btIdOf('ChIJ'), `x${btIdOf(placeId(2))}`]) {
    assert.strictEqual(s.placeIdFromBestTimeId(bad), null, String(bad));
  }
});

// A week whose days differ (so the axis proof can tell days apart) and whose
// hours vary from one to the next (so it can tell a shift of one hour).
const week = (seed, shift = 0) => Array.from({ length: 7 }, (_, d) => ({
  day_int: d,
  day_raw: Array.from({ length: 24 }, (_, slot) => {
    const s2 = (slot + shift + 24) % 24;
    return Math.min(100, 5 + d * 9 + ((s2 * 37 + seed * 11) % 41));
  }),
}));

test('a search line becomes the planner\'s venue shape, with seven whole days only', () => {
  const line = { venue_id: btIdOf(placeId(3)), name: 'Bar Three', address: '3 Main St', lat: 39.96, lng: -75.15, days: week(3) };
  const v = s.readSearchVenue(line, { venue_type: 'bar', rating: 4.4, reviews: 120 });
  assert.strictEqual(v.placeId, placeId(3));
  assert.strictEqual(v.type, 'BAR');
  assert.strictEqual(v.rating, 4.4);
  assert.strictEqual(v.reviews, 120);
  assert.strictEqual(v.days.size, 7);
  assert.strictEqual(v.days.get(2).length, 24);
  assert.strictEqual(s.readSearchVenue({ ...line, days: week(3).slice(0, 6) }, null), null, 'six days');
  const short = week(3); short[4] = { day_int: 4, day_raw: short[4].day_raw.slice(0, 23) };
  assert.strictEqual(s.readSearchVenue({ ...line, days: short }, null), null, 'a day of 23 slots');
  const twice = week(3); twice[6] = { ...twice[6], day_int: 5 };
  assert.strictEqual(s.readSearchVenue({ ...line, days: twice }, null), null, 'a day given twice');
  const noInfo = s.readSearchVenue(line, null);
  assert.strictEqual(noInfo.type, null);
  assert.deepStrictEqual(noInfo.googleTypes, []);
  assert.strictEqual(s.readSearchVenue(line, { rating: 9, reviews: -2 }).rating, null);
  assert.deepStrictEqual(s.readSearchVenue(line, { venue_type: 'BEER', venue_types: [' Bar ', 7, null, 'irish_pub'] }).googleTypes,
    ['bar', 'irish_pub']);
  assert.deepStrictEqual(s.readSearchVenue(line, { venue_types: 'bar' }).googleTypes, [], 'a string is not a list');
});

test('a BEER or OTHER venue is filed by its Google types, exact matches only; no other type is', () => {
  const cat = (type, googleTypes) => s.searchCategory({ type, googleTypes });
  assert.strictEqual(cat('BAR', []), 'bar', 'a mapped BestTime type decides alone');
  assert.strictEqual(cat('BAR', ['cafe']), 'bar');
  assert.strictEqual(cat('BEER', ['sports_bar', 'bar', 'restaurant']), 'bar');
  assert.strictEqual(cat('BEER', ['pub']), 'bar');
  assert.strictEqual(cat('BEER', ['brewery', 'bar']), 'brewery', 'addDemandVenues\' order: brewery before bar');
  assert.strictEqual(cat('OTHER', ['restaurant', 'coffee_shop']), 'cafe');
  assert.strictEqual(cat('OTHER', ['night_club', 'bar']), 'nightclub');
  for (const [type, googleTypes] of [
    ['BEER', ['liquor_store', 'store']], // a beer shop
    ['BEER', ['irish_pub']], // no exact match, and no default
    ['OTHER', ['cocktail_bar', 'lounge']],
    ['OTHER', []],
    ['OTHER', ['supermarket', 'cafe']], // a shop's crowd, whatever counter it keeps
    ['OTHER', ['coffee_shop', 'gas_station']],
    ['BEER', ['bar', 'stadium']],
    ['GROCERY', ['supermarket', 'cafe']], // only BEER and OTHER look past their type
    ['SPORTS_COMPLEX', ['stadium', 'bar']],
    [null, ['bar']],
  ]) {
    assert.strictEqual(cat(type, googleTypes), undefined, `${type} ${googleTypes}`);
  }
  assert.deepStrictEqual([...s.TYPES_FILED_BY_GOOGLE_TYPES], ['BEER', 'OTHER']);
  assert.strictEqual(cat('OTHER', undefined), undefined, 'a venue shape with no type list');
  const { exactCategoryFor } = require('../scripts/ml/addDemandVenues');
  assert.strictEqual(exactCategoryFor(['restaurant', 'bar']), 'bar');
  assert.strictEqual(exactCategoryFor(['establishment']), null);
  assert.strictEqual(exactCategoryFor(undefined), null);
});

function writeDir(lines, info) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-harvest-'));
  fs.writeFileSync(path.join(dir, 'venues.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'venue_info.jsonl'), info.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

test('the run\'s files load once per venue, joined to their info lines', () => {
  const a = { venue_id: btIdOf(placeId(10)), name: 'A', lat: 39.95, lng: -75.16, days: week(1) };
  const b = { venue_id: 'ven_00', name: 'B', lat: 39.95, lng: -75.16, days: week(2) };
  const c = { venue_id: btIdOf(placeId(11)), name: 'C', lat: 39.95, lng: -75.16, days: week(3).slice(0, 5) };
  const dir = writeDir([a, a, b, c], [
    { venue_id: a.venue_id, status: 'OK', venue_type: 'BAR' },
    { venue_id: b.venue_id, status: 'Error' },
  ]);
  const { venues, counts } = s.loadSearchDir(dir);
  assert.deepStrictEqual(venues.map((v) => v.name), ['A', 'B']);
  assert.strictEqual(counts.duplicates, 1);
  assert.strictEqual(counts.notWholeWeek, 1);
  assert.strictEqual(counts.withInfo, 1, 'an info line that is not OK is not used');
  assert.strictEqual(counts.noPlaceId, 1);
  assert.strictEqual(venues[0].type, 'BAR');
});

// ---------------------------------------------------------------------------
// The planner, the axis proof and the gate, against an in-memory corpus.
// ---------------------------------------------------------------------------
const PHILLY = { lat: 39.9526, lng: -75.1652 };

function corpus({
  knownCount = 30, newCount = 5, storedShift = 0, newType = 'BAR', newGoogleTypes, epoch = 1763500000,
  status = 'found', created = '2026-10-01T00:00:00Z', updated = created, pseudoLastSeen = '2026-09-05T00:27:47Z',
} = {}) {
  const known = [];
  const stored = [];
  const lines = [];
  const info = [];
  for (let i = 0; i < knownCount; i++) {
    const pid = placeId(100 + i);
    const lat = PHILLY.lat + 0.002 * (i % 10);
    const lng = PHILLY.lng + 0.002 * Math.floor(i / 10);
    const days = week(i);
    known.push({ id: 1000 + i, google_place_id: pid, besttime_venue_id: btIdOf(pid), name: `Known Venue ${i}`,
      latitude: lat, longitude: lng, city: 'philly', is_active: true, venue_category: 'bar',
      besttime_status: status, created_at: new Date(created), updated_at: new Date(updated) });
    lines.push({ venue_id: btIdOf(pid), name: `Known Venue ${i}`, lat, lng, days });
    // What the corpus stored for it, through the same transform, shifted by
    // `storedShift` slots to model an axis the search does not share, and
    // stamped with an epoch as collectWeekly stamps a forecast (or not).
    const cells = h.weekCells(week(i, storedShift).map((d) => [d.day_int, d.day_raw]));
    for (const c of cells) {
      stored.push({ venue_id: 1000 + i, day_of_week: c.dayOfWeek, hour: c.hour, busyness_pct: c.busyness, besttime_epoch: epoch });
    }
  }
  for (let j = 0; j < newCount; j++) {
    const pid = placeId(500 + j);
    lines.push({ venue_id: btIdOf(pid), name: `Fresh Place ${j}`, lat: PHILLY.lat - 0.01 - 0.003 * j, lng: PHILLY.lng - 0.01, days: week(j) });
    info.push({ venue_id: btIdOf(pid), status: 'OK', venue_type: newType, rating: 4.2, reviews: 50,
      ...(newGoogleTypes ? { venue_types: newGoogleTypes(j) } : {}) });
  }
  // One new venue at the Miami holdout: placed there, so skipped.
  const miami = placeId(900);
  lines.push({ venue_id: btIdOf(miami), name: 'Holdout Bar', lat: 25.7617, lng: -80.1918, days: week(9) });
  info.push({ venue_id: btIdOf(miami), status: 'OK', venue_type: 'BAR' });
  return { known, stored, lines, info, pseudoLastSeen: pseudoLastSeen && new Date(pseudoLastSeen) };
}

// The reference's two ml_venues reads, word for word (whitespace collapsed): a
// change to either, such as dropping MAX(updated_at) or a condition, fails here.
const PSEUDO_LAST_SEEN = "(SELECT GREATEST(MAX(created_at), MAX(updated_at)) FROM ml_venues WHERE google_place_id LIKE 'bt\\_%' ESCAPE '\\')";
const PSEUDO_LAST_SEEN_QUERY = `SELECT ${PSEUDO_LAST_SEEN} AS last`;
const FILTER_REFERENCE_QUERY = 'SELECT id FROM ml_venues WHERE id = ANY($1::bigint[]) AND besttime_status = ANY($2::text[]) '
  + 'AND created_at < $3::timestamptz AND updated_at <= created_at '
  + `AND created_at > COALESCE(${PSEUDO_LAST_SEEN}, '-infinity'::timestamptz)`;

// The reads the planner and the proof make, the two index checks, and (when
// `writes` is given) a client that records what writeOne sends under the lock.
function fakePool({ known, stored, pseudoLastSeen = null }, writes = null) {
  let nextId = 9000;
  return {
    connects: 0,
    async connect() {
      this.connects++;
      if (!writes) throw new Error('a write was attempted');
      return {
        release() {},
        async query(sql, params = []) {
          const q = String(sql).replace(/\s+/g, ' ').trim();
          if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(q) || /pg_advisory_xact_lock/.test(q)) return { rows: [] };
          if (q.startsWith('SELECT 1 FROM ml_venues WHERE besttime_venue_id = $1 OR google_place_id = $2')) {
            return { rows: known.filter((r) => r.besttime_venue_id === params[0] || r.google_place_id === params[1]) };
          }
          if (q.startsWith('SELECT id, name, latitude, longitude FROM ml_venues')) return { rows: [] };
          if (q.startsWith('INSERT INTO ml_venues')) {
            const cols = ['google_place_id', 'besttime_venue_id', 'name', 'address', 'city', 'latitude', 'longitude',
              'venue_category', 'rating', 'review_count', 'timezone', 'besttime_status'];
            const row = { id: nextId++, is_active: false, price_level: null };
            cols.forEach((c, i) => { row[c] = params[i]; });
            writes.venues.push(row);
            return { rows: [row] };
          }
          if (q.startsWith('INSERT INTO ml_training_data')) {
            // 26 parameters a cell (harvestVenueFilter upsertWeek); busyness is the 16th.
            const n = params.length / 26;
            for (let i = 0; i < n; i++) writes.rows.push({ venue_id: params[i * 26], busyness: params[i * 26 + 15] });
            return { rows: Array.from({ length: n }, () => ({ inserted: true })) };
          }
          if (q.startsWith('UPDATE ml_venues SET last_collected_at')) return { rows: [] };
          throw new Error(`unexpected write-path query: ${q.slice(0, 90)}`);
        },
      };
    },
    async query(sql, params) {
      const q = String(sql);
      if (/FROM pg_class c/.test(q)) return { rows: [{ indisvalid: true }] };
      if (/FROM ml_venues\s+WHERE besttime_venue_id = ANY/.test(q)) {
        return { rows: known.filter((r) => params[0].includes(r.besttime_venue_id) || params[1].includes(r.google_place_id)) };
      }
      if (/FROM ml_venues\s+WHERE latitude BETWEEN/.test(q)) return { rows: known };
      const flat = q.replace(/\s+/g, ' ').trim();
      if (flat === PSEUDO_LAST_SEEN_QUERY) return { rows: [{ last: pseudoLastSeen }] };
      if (flat === FILTER_REFERENCE_QUERY) {
        const [ids, statuses, before] = params;
        return { rows: known.filter((r) => ids.includes(r.id) && statuses.includes(r.besttime_status)
          && r.created_at < new Date(before) && r.updated_at <= r.created_at
          && (pseudoLastSeen == null || r.created_at > pseudoLastSeen)) };
      }
      if (/FROM ml_training_data/.test(q)) {
        assert.match(q, /AND \(besttime_epoch IS NOT NULL OR venue_id = ANY\(\$2::bigint\[\]\)\)/);
        return { rows: stored.filter((r) => params[0].includes(Number(r.venue_id))
          && (r.besttime_epoch != null || params[1].includes(Number(r.venue_id)))) };
      }
      throw new Error(`unexpected query: ${q.slice(0, 80)}`);
    },
  };
}

// Quiet, and with every network call refused: the script reads files and the
// database only, so a request from it or from anything it calls fails the test.
const quiet = async (fn) => {
  const saved = [console.log, console.error, globalThis.fetch];
  console.log = () => {}; console.error = () => {};
  globalThis.fetch = async () => { throw new Error('a network request was made'); };
  try { return await fn(); } finally { [console.log, console.error, globalThis.fetch] = saved; }
};

test('a dry run proves the axis on the known venues and plans only the new ones', async () => {
  const c = corpus();
  const dir = writeDir(c.lines, c.info);
  const pool = fakePool(c);
  const summary = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${dir}`], pool }));
  assert.strictEqual(summary.axisVerdict.pass, true, summary.axisVerdict.reason);
  assert.strictEqual(summary.axis.bestShift, 0);
  assert.deepStrictEqual([summary.reference.stamped, summary.reference.harvested], [30, 0]);
  assert.strictEqual(summary.plan.known_bt, 30);
  assert.strictEqual(summary.plan.new, 5);
  assert.strictEqual(summary.rowsPlanned, 5 * 168);
  assert.strictEqual(summary.exitCode, 0);
  assert.strictEqual(pool.connects, 0, 'a dry run writes nothing');
});

test('a --commit whose axis proof fails writes nothing', async () => {
  const c = corpus({ storedShift: 6 });
  const dir = writeDir(c.lines, c.info);
  const pool = fakePool(c);
  const summary = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${dir}`, '--commit'], pool }));
  assert.strictEqual(summary.axisVerdict.pass, false);
  assert.strictEqual(pool.connects, 0);
  assert.strictEqual(summary.venuesWritten, 0);
  assert.strictEqual(summary.exitCode, 1);
});

test('a --commit that passes writes the new venues, under their decoded place id, and nothing for the known', async () => {
  const c = corpus({ newCount: 3 });
  const dir = writeDir(c.lines, c.info);
  const writes = { venues: [], rows: [] };
  const summary = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${dir}`, '--commit'], pool: fakePool(c, writes) }));
  assert.strictEqual(summary.axisVerdict.pass, true, summary.axisVerdict.reason);
  assert.strictEqual(summary.venuesInserted, 3);
  assert.strictEqual(summary.rowsWritten, 3 * 168);
  assert.strictEqual(summary.exitCode, 0);
  assert.deepStrictEqual(writes.venues.map((v) => v.google_place_id).sort(), [placeId(500), placeId(501), placeId(502)]);
  for (const v of writes.venues) {
    assert.strictEqual(v.besttime_venue_id, btIdOf(v.google_place_id));
    assert.strictEqual(v.city, 'philly');
    assert.strictEqual(v.timezone, 'America/New_York');
    assert.strictEqual(v.venue_category, 'bar');
    assert.strictEqual(v.besttime_status, h.HARVEST_STATUS);
    assert.strictEqual(v.rating, 4.2);
  }
  const knownIds = new Set(c.known.map((r) => r.id));
  assert.ok(writes.rows.every((r) => !knownIds.has(r.venue_id)), 'no row of a known venue is written');
});

test('the axis is not proved against stored rows a search may have produced', async () => {
  // Stored rows with no epoch on a venue the filter harvest did not create:
  // discoverBestTime once wrote weekly rows from this same search field.
  // Compared with themselves they would pass any axis.
  const c = corpus({ epoch: null });
  const dir = writeDir(c.lines, c.info);
  const pool = fakePool(c);
  const summary = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${dir}`, '--commit'], pool }));
  assert.strictEqual(summary.axis.venues, 0);
  assert.strictEqual(summary.axisVerdict.pass, false);
  assert.strictEqual(pool.connects, 0);
});

test('a venue the filter harvest created before the searches began is a reference, epoch or not', async () => {
  const c = corpus({ epoch: null, status: h.HARVEST_STATUS });
  const dir = writeDir(c.lines, c.info);
  const summary = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${dir}`], pool: fakePool(c) }));
  assert.strictEqual(summary.axis.venues, 30);
  assert.deepStrictEqual([summary.reference.stamped, summary.reference.harvested], [0, 30]);
  assert.deepStrictEqual(summary.reference.pseudoLastSeen, new Date('2026-09-05T00:27:47Z'));
  assert.strictEqual(summary.axisVerdict.pass, true, summary.axisVerdict.reason);
  assert.strictEqual(summary.exitCode, 0);
  // Promoted out of 'harvested' with its rows kept: still the filter's week.
  const promoted = corpus({ epoch: null, status: 'harvest_measured' });
  const again = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${writeDir(promoted.lines, promoted.info)}`], pool: fakePool(promoted) }));
  assert.strictEqual(again.axis.venues, 30);
  // No pseudo venue at all: nothing to be newer than, so the other tests decide.
  const none = corpus({ epoch: null, status: h.HARVEST_STATUS, pseudoLastSeen: null });
  const bare = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${writeDir(none.lines, none.info)}`], pool: fakePool(none) }));
  assert.strictEqual(bare.axis.venues, 30);
  assert.strictEqual(bare.reference.pseudoLastSeen, null);
  // Stamped cells on a filter-harvested venue: counted once, as harvested.
  const both = corpus({ status: h.HARVEST_STATUS });
  const mixed = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${writeDir(both.lines, both.info)}`], pool: fakePool(both) }));
  assert.deepStrictEqual([mixed.reference.stamped, mixed.reference.harvested], [0, 30]);
  // And the filter's week still has to sit on the search's axis.
  const shifted = corpus({ epoch: null, status: h.HARVEST_STATUS, storedShift: 6 });
  const pool = fakePool(shifted);
  const refused = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${writeDir(shifted.lines, shifted.info)}`, '--commit'], pool }));
  assert.strictEqual(refused.axisVerdict.pass, false);
  assert.strictEqual(pool.connects, 0);
});

test('a harvested venue made after the searches began, updated since, or older than the last pseudo venue, is not a reference', async () => {
  // Created after the searches began: it could be this script's own write,
  // whose week is the search's curve itself.
  const own = corpus({ epoch: null, status: h.HARVEST_STATUS, created: '2026-11-20T02:00:01Z' });
  const a = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${writeDir(own.lines, own.info)}`], pool: fakePool(own) }));
  assert.strictEqual(a.axis.venues, 0);
  assert.strictEqual(a.axisVerdict.pass, false);
  // Created before a pseudo bt_ venue was last created or touched: a
  // discovery run then may have overwritten its week with the search field.
  const touched = corpus({ epoch: null, status: h.HARVEST_STATUS, created: '2026-10-01T00:00:00Z', pseudoLastSeen: '2026-10-02T00:00:00Z' });
  const b = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${writeDir(touched.lines, touched.info)}`], pool: fakePool(touched) }));
  assert.strictEqual(b.axis.venues, 0);
  // Updated after it was created: discoverBestTime's upsert sets updated_at on
  // every venue it writes rows for, a run that minted no pseudo venue included.
  const upserted = corpus({ epoch: null, status: h.HARVEST_STATUS, created: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:01Z' });
  const u = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${writeDir(upserted.lines, upserted.info)}`], pool: fakePool(upserted) }));
  assert.strictEqual(u.axis.venues, 0);
  // A status no filter harvest writes is not a reference without a stamp.
  const other = corpus({ epoch: null, status: 'found' });
  const d = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${writeDir(other.lines, other.info)}`], pool: fakePool(other) }));
  assert.strictEqual(d.axis.venues, 0);
  assert.strictEqual(s.SEARCH_RUNS_BEGAN, '2026-11-20T02:00:00Z');
  assert.deepStrictEqual(s.FILTER_HARVEST_STATUSES, [h.HARVEST_STATUS, 'harvest_measured']);
});

test('a database missing either upsert target is refused before anything is read or planned', async () => {
  const c = corpus();
  const dir = writeDir(c.lines, c.info);
  const { VENUE_ID_INDEX } = require('../scripts/ml/discoverBestTime');
  const { WEEKLY_SLOT_INDEX } = require('../scripts/ml/collectWeekly');
  assert.ok(VENUE_ID_INDEX && WEEKLY_SLOT_INDEX);
  for (const missing of [VENUE_ID_INDEX, WEEKLY_SLOT_INDEX]) {
    const pool = fakePool(c);
    const inner = pool.query.bind(pool);
    pool.query = async (sql, params) => (/FROM pg_class c/.test(String(sql)) && params[0] === missing
      ? { rows: [] } : inner(sql, params));
    await assert.rejects(() => quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${dir}`], pool })),
      new RegExp(`${missing} does not exist`), missing);
  }
});

test('a venue with no coordinates is skipped, not placed at 0,0, and an unusable first line does not hide a whole later one', () => {
  const pid = placeId(77);
  const whole = { venue_id: btIdOf(pid), name: 'Late Whole', lat: 39.95, lng: -75.16, days: week(1) };
  const dir = writeDir([
    null,
    { ...whole, days: week(1).slice(0, 3) },
    whole,
    { venue_id: btIdOf(placeId(78)), name: 'Nowhere', lat: null, lng: null, days: week(2) },
  ], []);
  const { venues, counts } = s.loadSearchDir(dir);
  assert.deepStrictEqual(venues.map((v) => v.name), ['Late Whole', 'Nowhere']);
  assert.strictEqual(counts.notWholeWeek, 1);
  assert.ok(Number.isNaN(venues[1].lat) && Number.isNaN(venues[1].lng));
  const { skipped } = h.planVenues(venues, { byBtId: new Map(), byPlaceId: new Map(), nearby: [] }, [...h.ALL_CITIES]);
  assert.strictEqual(skipped.noCoordinates, 1);
});

test('an id that decodes to no Google shape is counted unusable, not absent', () => {
  const v = s.readSearchVenue({ venue_id: btIdOf('EiAddressNotAVenue12345678'), name: 'X', lat: 39.95, lng: -75.16, days: week(1) }, null);
  assert.strictEqual(v.placeId, null);
  assert.strictEqual(v.rawPlaceId, 'EiAddressNotAVenue12345678');
});

test('a new venue whose type maps to no category is skipped, not written as unknown', async () => {
  const c = corpus({ newType: 'SPACESHIP_PORT' });
  const dir = writeDir(c.lines, c.info);
  const summary = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${dir}`], pool: fakePool(c) }));
  assert.strictEqual(summary.plan.new, 0);
  assert.strictEqual(summary.rowsPlanned, 0);
});

test('a new BEER venue whose Google types name a pub is written as a bar, and a beer shop is skipped', async () => {
  // Five new BEER venues: three pubs, two beer shops.
  const c = corpus({ newType: 'BEER', newGoogleTypes: (j) => (j < 3 ? ['pub', 'Bar'] : ['liquor_store']) });
  const dir = writeDir(c.lines, c.info);
  const writes = { venues: [], rows: [] };
  const summary = await quiet(() => s.harvestSearch({ argv: ['node', 'x', `--dir=${dir}`, '--commit'], pool: fakePool(c, writes) }));
  assert.strictEqual(summary.axisVerdict.pass, true, summary.axisVerdict.reason);
  assert.strictEqual(summary.plan.new, 3);
  assert.deepStrictEqual(summary.byGoogleTypes, { BEER: 3, OTHER: 0 });
  assert.deepStrictEqual(writes.venues.map((v) => v.google_place_id).sort(), [placeId(500), placeId(501), placeId(502)]);
  assert.ok(writes.venues.every((v) => v.venue_category === 'bar' && v.besttime_status === h.HARVEST_STATUS));
  assert.strictEqual(summary.rowsWritten, 3 * 168);
  // The filter harvest's own rule is unchanged: planned without searchCategory,
  // the same venues are all skipped as unmapped.
  const { venues } = s.loadSearchDir(dir);
  const { plan, skipped } = h.planVenues(venues, { byBtId: new Map(), byPlaceId: new Map(), nearby: [] }, [...h.ALL_CITIES]);
  assert.strictEqual(plan.filter((p) => p.kind === 'new' && /^Fresh Place/.test(p.venue.name)).length, 0);
  assert.ok(skipped.unmappedType >= 5);
});

test('arguments: --dir is required and must hold venues.jsonl', () => {
  assert.throws(() => s.parseArgs(['node', 'x']), /--dir/);
  assert.throws(() => s.parseArgs(['node', 'x', `--dir=${os.tmpdir()}${path.sep}no-such-run-dir`]), /venues\.jsonl/);
  assert.throws(() => s.parseArgs(['node', 'x', '--dir=x', '--live']), /unknown argument/);
});

test('the script makes no network request: it reads files and the database only', () => {
  const src = fs.readFileSync(require.resolve('../scripts/ml/harvestVenueSearch'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const needle of ['fetch(', 'https://', 'http://', 'require(\'https\')', 'require(\'http\')', 'bestTimeService']) {
    assert.ok(!code.includes(needle), needle);
  }
});
