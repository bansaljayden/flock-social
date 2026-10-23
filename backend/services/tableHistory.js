'use strict';
// ---------------------------------------------------------------------------
// TABLE HISTORY, READ BACK: what the seatings say about a venue's tables.
// ---------------------------------------------------------------------------
// services/sensorTables.js writes the live floor (sensor_table_states) and,
// behind it, one row per seating (sensor_table_seatings, migration 131). This
// module is everything the owner's table routes and the public summary make
// of those rows:
//
//   the floor, with likely_free_at and seats on each table   (ownerFloor)
//   the turn, wait and clear figures                         (tableStats)
//   how long a party of 2, 4, 6 or 8 waits                   (tableWaits)
//   which table fits each plan on the incoming feed          (tableIncoming)
//   the owner's two switches                                 (readTableSettings,
//                                                             writeTableSettings)
//   what the Flock app may know: counts and minutes          (publicSummaries)
//
// NOTHING HERE IS ABOUT A PERSON, in either direction. A seating is a table
// number, four times and a head count; the incoming feed is a party size and
// a time (services/incomingFlocks.js, which selects no name and no member);
// the public summary is counts and minutes and never a table number or a
// unit id. Each function below says what leaves it.
//
// THE VENUE'S CLOCK. A turn time depends on when the party sat (Friday at
// eight is not Tuesday at three), so the medians are kept by weekday and hour,
// and those have to be the venue's weekday and hour. The server knows a
// venue's IANA zone only where the corpus has it: ml_venues.timezone, written
// from Google's own timeZone for every corpus venue, and never a paid call
// from here. A venue outside the corpus is read in UTC and every answer that
// folds by hour says so: timeZone is the zone the weekdays and hours are on,
// and null when they are UTC, the same word GET /tables/hours uses, so no
// client can mistake the string 'UTC' for a venue's own clock. The name is
// checked with ICU (utils/venueZone.js validTimeZone) before Postgres sees
// it, and if Postgres still refuses it (22023, a name the two databases
// disagree on) the read is repeated in UTC rather than failing: a wrong clock
// is a worse answer than a stated one, and no answer at all is worse than
// both. After that fallback the cells are UTC cells, and every lookup into
// them (likely_free_at, the waits, the summary's minutes) is made with the
// UTC clock too, whatever zone the venue has.
//
// A DARK UNIT HAS NO SAY IN WHAT IS OPEN NOW. A venue with two boxes keeps
// both units' rows on the owner's floor (phase 1 settled that: the floor is
// every unit's tables, marked stale as a whole only when every unit is), but
// nothing ever removes the rows of a unit that stops sending altogether, and
// a back room unplugged at close would otherwise count ten free tables for
// as long as the front room stays live. So the counts, the fits, the waits
// and the suggestions are built only from rows a unit refreshed inside
// TABLES_STALE_AFTER_MINUTES (liveRows); the owner's floor still shows the
// rest, each marked stale.
//
// TWENTY SEATINGS BEFORE A MEDIAN IS SAID. A median of six turns is a
// coincidence with a decimal point, and likely_free_at built on one would
// tell a host "ten minutes" on the strength of the one slow table last
// Tuesday. So no median (overall or for one hour of one weekday) is given,
// and no likely_free_at or wait is built, from fewer than MIN_SEATINGS_FOR_MEDIAN
// closed seatings. An hour with too few falls back to the venue's overall
// median when THAT has enough, else to nothing, which the routes answer as
// null and the dashboard reads as "not yet known".
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { validTimeZone, clockInZone } = require('../utils/venueZone');
const {
  STATE_WORDS, TABLES_STALE_AFTER_MINUTES, noteTableClash, wantsTableAlerts,
} = require('./sensorTables');
const { listIncomingFlocks, partyOf } = require('./incomingFlocks');

// The window the turn medians read (likely_free_at, the waits, the public
// summary's busy hours), and the default and bounds of GET /tables/stats.
const TURN_WINDOW_DAYS = 28;
const STATS_DAYS_MIN = 7;
const STATS_DAYS_MAX = 90;
// How far back the largest party seen at a table stands in for its seat count.
const SEATS_WINDOW_DAYS = 30;
const MIN_SEATINGS_FOR_MEDIAN = 20;
// A table whose seats nobody has counted (no C from the unit, no party seen)
// fits a party up to this big: the common restaurant table. Whether it fits
// a bigger party is not known, and is said so (null), never guessed either way.
const UNKNOWN_SEATS_FIT_UP_TO = 4;
const WAIT_PARTIES = Object.freeze([2, 4, 6, 8]);
// An hour of a weekday is "full" when at least this share of its readings
// had every table in use.
const FULL_SHARE_MIN = 0.5;
// A floor whose newest row is older than this is no table data at all to the
// public summary (the owner's routes still show it, marked stale).
const SUMMARY_MAX_AGE_HOURS = 24;
const PUBLIC_PARTY_DEFAULT = 2;
const PUBLIC_PARTY_MAX = 30;
const SUMMARIES_MAX_PLACES = 50;

// ---------------------------------------------------------------------------
// The venue's zone, from the corpus.
// ---------------------------------------------------------------------------
const VENUE_ZONES_SQL = 'SELECT google_place_id, timezone FROM ml_venues WHERE google_place_id = ANY($1::varchar[])';

/**
 * The IANA zone of each place the corpus knows, as a Map of place id to zone
 * (absent, or null, when unknown or unusable). A failed read is "unknown" for
 * every place: the clock is a detail of the answer, not the answer.
 */
async function venueTimeZones(placeIds) {
  const zones = new Map();
  if (!placeIds.length) return zones;
  try {
    const { rows } = await pool.query(VENUE_ZONES_SQL, [placeIds]);
    for (const r of rows) zones.set(r.google_place_id, validTimeZone(r.timezone));
  } catch (err) {
    console.error('Venue time zone lookup failed; table hours are read in UTC:', err.message);
  }
  return zones;
}

async function venueTimeZone(placeId) {
  return (await venueTimeZones([placeId])).get(placeId) || null;
}

// A zone the SQL below can be handed: the venue's, or UTC.
const zoneOrUtc = (zone) => zone || 'UTC';

// Run a by-place, by-zone statement ($1 place ids, $2 their zones, $3 days).
// A zone Postgres will not take (22023) repeats the read in UTC for every
// place and says so, rather than failing the route over a clock.
async function queryInZones(sql, placeIds, zones, days) {
  const named = placeIds.map((id) => zoneOrUtc(zones.get(id)));
  try {
    const { rows } = await pool.query(sql, [placeIds, named, days]);
    return { rows, fellBack: false };
  } catch (err) {
    if (err.code !== '22023' || named.every((z) => z === 'UTC')) throw err;
    console.error('Postgres refused a venue time zone; table hours are read in UTC:', err.message);
    const { rows } = await pool.query(sql, [placeIds, placeIds.map(() => 'UTC'), days]);
    return { rows, fellBack: true };
  }
}

// ---------------------------------------------------------------------------
// The turn medians: how long parties sit, by weekday and hour, per venue.
//
// ONE STATEMENT PER READ, over every place asked about, with each place's
// own zone joined in, so the public summary of fifty venues costs one scan of
// the window and not fifty. GROUPING SETS gives the cells and the venue's
// overall row in the same pass; the overall row is the one with dow and
// hour NULL. Beside the turn median the overall row carries the two other
// figures GET /tables/stats reports: the share of seatings that waited, and
// the median time from the party leaving to the table cleared, over the
// seatings whose clear was seen (clear_minutes is NULL for the rest, and
// percentile_cont skips NULLs; cleared counts them).
//
// Every parameter has one cast, used the same way each time it appears, for
// __tests__/sqlParameterTypes.test.js.
// ---------------------------------------------------------------------------
const TURN_MEDIANS_SQL = `
  SELECT g.venue_place_id, g.dow, g.hour,
         COUNT(*)::int AS seatings,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY g.turn_minutes) AS median,
         AVG(CASE WHEN g.waited THEN 1.0 ELSE 0.0 END) AS waited_share,
         COUNT(g.clear_minutes)::int AS cleared,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY g.clear_minutes) AS clear_median
    FROM (
      SELECT s.venue_place_id,
             EXTRACT(DOW FROM (s.seated_at AT TIME ZONE z.zone))::int AS dow,
             EXTRACT(HOUR FROM (s.seated_at AT TIME ZONE z.zone))::int AS hour,
             (EXTRACT(EPOCH FROM (s.left_at - s.seated_at)) / 60)::float8 AS turn_minutes,
             s.waited,
             (EXTRACT(EPOCH FROM (s.cleared_at - s.left_at)) / 60)::float8 AS clear_minutes
        FROM sensor_table_seatings s
        JOIN unnest($1::varchar[], $2::text[]) AS z(place_id, zone) ON z.place_id = s.venue_place_id
       WHERE s.left_at IS NOT NULL
         AND s.seated_at >= NOW() - ($3::int * INTERVAL '1 day')
    ) g
   GROUP BY GROUPING SETS ((g.venue_place_id, g.dow, g.hour), (g.venue_place_id))`;

const numberOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const cellKey = (dow, hour) => `${dow}:${hour}`;

/**
 * The medians over the last `days` days for every place in `placeIds`, each
 * in its zone: { byVenue: Map<placeId, { overall, cells }>, fellBack }.
 * overall is { seatings, median, waited_share, cleared, clear_median } and
 * cells a Map of "dow:hour" to { dow, hour, seatings, median }, raw and
 * unrounded; the floor of MIN_SEATINGS_FOR_MEDIAN is applied by the readers.
 */
async function turnMedians(placeIds, zones, days = TURN_WINDOW_DAYS) {
  const byVenue = new Map();
  if (!placeIds.length) return { byVenue, fellBack: false };
  const { rows, fellBack } = await queryInZones(TURN_MEDIANS_SQL, placeIds, zones, days);
  for (const r of rows) {
    let v = byVenue.get(r.venue_place_id);
    if (!v) {
      v = { overall: { seatings: 0, median: null, waited_share: null, cleared: 0, clear_median: null }, cells: new Map() };
      byVenue.set(r.venue_place_id, v);
    }
    if (r.dow === null || r.dow === undefined) {
      v.overall = {
        seatings: Number(r.seatings),
        median: numberOrNull(r.median),
        waited_share: numberOrNull(r.waited_share),
        cleared: Number(r.cleared),
        clear_median: numberOrNull(r.clear_median),
      };
    } else {
      const dow = Number(r.dow);
      const hour = Number(r.hour);
      v.cells.set(cellKey(dow, hour), { dow, hour, seatings: Number(r.seatings), median: numberOrNull(r.median) });
    }
  }
  return { byVenue, fellBack };
}

// The turn median a seating started at (dow, hour) may be built on: the
// cell's when it has enough seatings, else the venue's overall when that
// has, else null.
function medianFor(venue, dow, hour) {
  if (!venue) return null;
  const cell = venue.cells.get(cellKey(dow, hour));
  if (cell && cell.seatings >= MIN_SEATINGS_FOR_MEDIAN && cell.median !== null) return cell.median;
  const all = venue.overall;
  if (all && all.seatings >= MIN_SEATINGS_FOR_MEDIAN && all.median !== null) return all.median;
  return null;
}

/**
 * When a table seated at `since` is likely free: since plus the median turn
 * for that weekday and hour in `zone` (UTC when null), as a Date, or null
 * when there is not enough history to say.
 */
function likelyFreeAt(since, zone, venue) {
  const ms = new Date(since).getTime();
  if (!Number.isFinite(ms)) return null;
  const clock = clockInZone(ms, zoneOrUtc(zone));
  if (!clock) return null;
  const median = medianFor(venue, clock.day, clock.hour);
  return median === null ? null : new Date(ms + Math.round(median * 60000));
}

// ---------------------------------------------------------------------------
// The floor, with the seats fallback joined in.
//
// EVERY UNIT'S FLOOR, settled as phase 1 settled it (routes/sensors.js used to
// hold this statement): a venue with more than one box numbers its tables
// apart, two units reporting the same number are not merged into one tile
// (the newer row is shown and the clash logged once an hour), rows come
// newest first within a number so the keeper is the first row seen, and the
// place is checked on the rows themselves. Over every place asked about at
// once, for the public summary.
//
// SEATS, AND THE PARTY SEEN. The unit's own count (C) when it ever sent one,
// kept on the row by the floor writer, is the table's seats; the largest
// party seen at the table in the last SEATS_WINDOW_DAYS is a second, weaker
// fact (the table's capacity as actually used), and the two are handed to
// the owner apart (seats, party_max) so a six-top that only sat couples this
// month is never tiled "2 seats". A fit is judged on the seats, else on the
// party seen, else on the unknown-table default (fitOf). The aggregate is
// one scan of the venue's recent seatings joined to the floor, not a lookup
// per table, and it is joined on the VENUE as well as the unit and table: a
// unit moved from one venue to another keeps its old seatings under the old
// venue, and the batch summary reads many venues' floors in one statement,
// so without the venue in the join one venue's head counts would stand in
// as another venue's seats. NULLIF turns "parties of nobody" (every seating
// at party_max 0) back into unknown.
// ---------------------------------------------------------------------------
const TABLE_FLOOR_SQL = `
  SELECT s.venue_place_id, s.sensor_device_id, s.table_no, s.people, s.state, s.state_since, s.seats, s.updated_at,
         s.updated_at < NOW() - $2::int * INTERVAL '1 minute' AS stale,
         m.party_max AS party_max_seen
    FROM sensor_table_states s
    LEFT JOIN (
      SELECT g.venue_place_id, g.sensor_device_id, g.table_no, NULLIF(MAX(g.party_max), 0) AS party_max
        FROM sensor_table_seatings g
       WHERE g.venue_place_id = ANY($1::varchar[])
         AND g.seated_at >= NOW() - ($3::int * INTERVAL '1 day')
       GROUP BY g.venue_place_id, g.sensor_device_id, g.table_no
    ) m ON m.venue_place_id = s.venue_place_id AND m.sensor_device_id = s.sensor_device_id AND m.table_no = s.table_no
   WHERE s.venue_place_id = ANY($1::varchar[])
   ORDER BY s.venue_place_id, s.table_no, s.updated_at DESC, s.sensor_device_id`;

/**
 * The floor of every place in `placeIds`: a Map of place id to { kept, newest,
 * stale }, only for places with rows. kept is each table's row (the newer
 * row where two units share a number), in number order; newest is the newest
 * row at the place; stale is whether that row is past TABLES_STALE_AFTER_MINUTES.
 * Unit ids stay in the rows and never leave this module except in the clash
 * note.
 */
async function readFloors(placeIds) {
  const floors = new Map();
  if (!placeIds.length) return floors;
  const { rows } = await pool.query(TABLE_FLOOR_SQL, [placeIds, TABLES_STALE_AFTER_MINUTES, SEATS_WINDOW_DAYS]);
  const clashes = new Map();
  for (const r of rows) {
    let f = floors.get(r.venue_place_id);
    if (!f) {
      f = { kept: [], newest: r, stale: r.stale === true };
      floors.set(r.venue_place_id, f);
    }
    if (new Date(r.updated_at) > new Date(f.newest.updated_at)) {
      f.newest = r;
      f.stale = r.stale === true;
    }
    const last = f.kept[f.kept.length - 1];
    if (last && Number(last.table_no) === Number(r.table_no)) {
      // The same number from another unit. The rows arrive newest first, so
      // the row already kept is the newer one; this one is only noted.
      if (!clashes.has(r.venue_place_id)) clashes.set(r.venue_place_id, []);
      clashes.get(r.venue_place_id).push({ table_no: Number(r.table_no), shown: last.sensor_device_id, hidden: r.sensor_device_id });
      continue;
    }
    f.kept.push(r);
  }
  for (const [placeId, list] of clashes) noteTableClash(placeId, list);
  return floors;
}

const hasParty = (r) => r.state === 's' || r.state === 'w';

// Rows a unit refreshed inside TABLES_STALE_AFTER_MINUTES (the per-row stale
// the floor read computes): what "open now", a fit, a wait and a suggestion
// may be built on. Every live reading rewrites all of a unit's rows with one
// updated_at and deletes the rest, so a row's staleness is its unit's.
const liveRows = (kept) => kept.filter((r) => r.stale !== true);

// The seats a fit is judged on (item 3 of the contract): the unit's count,
// else the largest party seen at the table, else unknown.
function seatsOf(r) {
  if (r.seats !== null && r.seats !== undefined) return Number(r.seats);
  if (r.party_max_seen !== null && r.party_max_seen !== undefined) return Number(r.party_max_seen);
  return null;
}

// Whether a table with `seats` seats takes a party of `party`: true or false
// from a known count, and with the count unknown (null) true up to the
// unknown-table default and null above it. Nothing says a table nobody has
// counted or sat six at does not seat six, so nothing here says so either.
function fits(seats, party) {
  if (seats !== null) return seats >= party;
  return party <= UNKNOWN_SEATS_FIT_UP_TO ? true : null;
}

const fitOf = (r, party) => fits(seatsOf(r), party);

// Each kept row's likely_free_at (a Date or null), once per floor read.
function likelyByTable(kept, zone, venue) {
  const out = new Map();
  for (const r of kept) out.set(Number(r.table_no), hasParty(r) ? likelyFreeAt(r.state_since, zone, venue) : null);
  return out;
}

// What the free tables say about a party: { fits: true, row } with the
// lowest-numbered free table known to fit; else { fits: null, row } with the
// lowest free table whose fit is not known, because "no table fits" cannot
// be said while one of them might; else { fits: false, row: null }, which is
// every free table known too small, or none free.
function openFor(kept, party) {
  let unknown = null;
  for (const r of kept) {
    if (r.state !== 'f') continue;
    const fit = fitOf(r, party);
    if (fit === true) return { fits: true, row: r };
    if (fit === null && unknown === null) unknown = r;
  }
  return unknown ? { fits: null, row: unknown } : { fits: false, row: null };
}

// The seated or waiting table known to fit that is likely free soonest, among
// those with a likely_free_at before `beforeMs` (no bound when null), or null.
function soonestFitting(kept, party, likely, beforeMs = null) {
  let best = null;
  let bestAt = null;
  for (const r of kept) {
    if (!hasParty(r) || fitOf(r, party) !== true) continue;
    const at = likely.get(Number(r.table_no));
    if (!at) continue;
    if (beforeMs !== null && at.getTime() >= beforeMs) continue;
    if (bestAt === null || at.getTime() < bestAt.getTime()) {
      best = r;
      bestAt = at;
    }
  }
  return best ? { row: best, at: bestAt } : null;
}

// Whole minutes from now until `at`, never negative: a table past its likely
// time is "0", not a countdown below zero.
function minutesUntil(at, nowMs) {
  return Math.max(0, Math.ceil((at.getTime() - nowMs) / 60000));
}

// One table as the owner's floor shows it: the unit's seat count and the
// largest party seen apart, each null when there is none. No unit id.
function tableView(r, likely) {
  const at = likely.get(Number(r.table_no));
  return {
    number: Number(r.table_no),
    people: Number(r.people),
    state: STATE_WORDS[r.state],
    since: new Date(r.state_since).toISOString(),
    seats: r.seats === null || r.seats === undefined ? null : Number(r.seats),
    party_max: r.party_max_seen === null || r.party_max_seen === undefined ? null : Number(r.party_max_seen),
    likely_free_at: at ? at.toISOString() : null,
  };
}

// The floor, its medians and its zone for one place, read together: the zone
// and the floor in parallel, the medians once the zone is known. The clock
// the cells are looked up with is the one they were folded in: the venue's,
// or UTC after Postgres refused the venue's (queryInZones).
async function floorContext(placeId) {
  const [zones, floors] = await Promise.all([venueTimeZones([placeId]), readFloors([placeId])]);
  const zone = zones.get(placeId) || null;
  const turns = await turnMedians([placeId], zones);
  const floor = floors.get(placeId) || null;
  const venue = turns.byVenue.get(placeId) || null;
  const likely = likelyByTable(floor ? floor.kept : [], turns.fellBack ? null : zone, venue);
  return { zone, floor, venue, likely };
}

// The floor's clock words, shared by the floor and the waits.
function floorClock(floor) {
  if (!floor) return { updated_at: null, stale: true };
  return { updated_at: new Date(floor.newest.updated_at).toISOString(), stale: floor.stale };
}

/**
 * GET /tables: { tables: [{ number, people, state, since, seats, party_max,
 * likely_free_at }], updated_at, stale, next_free }. seats is the unit's own
 * count or null; party_max the largest party seen at the table in
 * SEATS_WINDOW_DAYS or null. next_free is the seated or waiting table whose
 * party has sat longest (the best guess at which table frees up next; on a
 * tie, the lower number), null when no table has a party. Every unit's rows,
 * stale ones included. With no rows at all: no tables, no time, stale,
 * nothing next.
 */
async function ownerFloor(placeId) {
  const { floor, likely } = await floorContext(placeId);
  if (!floor) return { tables: [], updated_at: null, stale: true, next_free: null };
  let longestSeated = null;
  for (const r of floor.kept) {
    if (hasParty(r) && (longestSeated === null || new Date(r.state_since) < new Date(longestSeated.state_since))) {
      longestSeated = r;
    }
  }
  return {
    tables: floor.kept.map((r) => tableView(r, likely)),
    ...floorClock(floor),
    next_free: longestSeated ? Number(longestSeated.table_no) : null,
  };
}

/**
 * GET /tables/waits: { updated_at, stale, by_party: [{ party, open_now,
 * minutes, table }] } for parties of 2, 4, 6 and 8, over the live units'
 * rows. open_now is true when a free table is known to fit (minutes 0, table
 * that table's number, the lowest); null when tables are free but none is
 * known to fit and one might (minutes null, table the lowest such table);
 * else false, with minutes until the soonest likely_free_at among the seated
 * tables known to fit and that table's number, both null with no such table
 * or no history.
 */
async function tableWaits(placeId, nowMs = Date.now()) {
  const { floor, likely } = await floorContext(placeId);
  const kept = floor ? liveRows(floor.kept) : [];
  return {
    ...floorClock(floor),
    by_party: WAIT_PARTIES.map((party) => waitFor(kept, party, likely, nowMs)),
  };
}

function waitFor(kept, party, likely, nowMs) {
  const open = openFor(kept, party);
  if (open.fits === true) return { party, open_now: true, minutes: 0, table: Number(open.row.table_no) };
  // A free table that might seat the party: no wait is said for a party that
  // may not have to wait at all.
  if (open.fits === null) return { party, open_now: null, minutes: null, table: Number(open.row.table_no) };
  const soon = soonestFitting(kept, party, likely);
  if (!soon) return { party, open_now: false, minutes: null, table: null };
  return { party, open_now: false, minutes: minutesUntil(soon.at, nowMs), table: Number(soon.row.table_no) };
}

/**
 * GET /tables/incoming: { flocks: [{ id, event_time, status, party,
 * suggestion }] }, the plans the dashboard's incoming feed lists (the same
 * statement, services/incomingFlocks.js: no name, no member, no user text),
 * each with the best table known to fit it: free now, else the one likely
 * free soonest before the plan's time, else null. Over the live units' rows.
 */
async function tableIncoming(placeId) {
  const [flocks, ctx] = await Promise.all([listIncomingFlocks(placeId), floorContext(placeId)]);
  const kept = ctx.floor ? liveRows(ctx.floor.kept) : [];
  return {
    flocks: flocks.map((f) => {
      const party = partyOf(f);
      return {
        id: f.id,
        // As the feed hands it over, so the two routes agree about a plan.
        event_time: f.event_time,
        status: f.status,
        party,
        suggestion: suggestionFor(kept, party, naiveUtcInstant(f.event_time), ctx.likely),
      };
    }),
  };
}

// flocks.event_time is a TIMESTAMP WITHOUT TIME ZONE holding a UTC wall
// clock (config/database.js says why), and the driver reads such a column in
// THIS process's zone: right on Railway, which runs UTC, and four hours off
// on a laptop in New York. The instant is rebuilt from the wall clock the
// Date carries, so "before the plan's time" means the same thing on both.
// A string (a fixture, or a driver configured to hand text back) is read as
// written.
function naiveUtcInstant(v) {
  if (v instanceof Date) {
    return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds(), v.getMilliseconds());
  }
  return new Date(v).getTime();
}

// A suggestion names a table KNOWN to fit; a free table whose fit is not
// known is not suggested, and does not stop a fitting seated table from
// being, since "table 4 fits them and is likely free at eight" stays true
// whatever table 3 turns out to seat.
function suggestionFor(kept, party, eventTimeMs, likely) {
  const open = openFor(kept, party);
  if (open.fits === true) return { table: Number(open.row.table_no), free_now: true, likely_free_at: null };
  const soon = soonestFitting(kept, party, likely, Number.isFinite(eventTimeMs) ? eventTimeMs : null);
  if (!soon) return null;
  return { table: Number(soon.row.table_no), free_now: false, likely_free_at: soon.at.toISOString() };
}

// ---------------------------------------------------------------------------
// GET /tables/stats: the turn, wait and clear figures, and the full hours.
//
// FULL HOURS come from the readings, not the seatings: each reading carries
// how many tables the unit watched and how many had a party (migration 130),
// and an hour of a weekday is full when at least FULL_SHARE_MIN of its
// readings had every table in use. A venue with two units has two readings a
// minute, each about its own room, and a reading counts as full when its own
// room was; the share is over all of them.
// ---------------------------------------------------------------------------
const FULL_HOURS_SQL = `
  SELECT v.venue_place_id,
         EXTRACT(DOW FROM (v.recorded_at AT TIME ZONE z.zone))::int AS dow,
         EXTRACT(HOUR FROM (v.recorded_at AT TIME ZONE z.zone))::int AS hour,
         COUNT(*)::int AS readings,
         COUNT(*) FILTER (WHERE v.tables_occupied = v.tables_total)::int AS full_readings
    FROM venue_sensor_data v
    JOIN unnest($1::varchar[], $2::text[]) AS z(place_id, zone) ON z.place_id = v.venue_place_id
   WHERE v.tables_total > 0
     AND v.recorded_at >= NOW() - ($3::int * INTERVAL '1 day')
   GROUP BY 1, 2, 3`;

/**
 * The full hours of every place in `placeIds` over `days`: a Map of place id
 * to [{ dow, hour, share }] (share to two decimals), cells at or above
 * FULL_SHARE_MIN only, in weekday then hour order.
 */
async function fullHours(placeIds, zones, days = TURN_WINDOW_DAYS) {
  const byVenue = new Map();
  if (!placeIds.length) return { byVenue, fellBack: false };
  const { rows, fellBack } = await queryInZones(FULL_HOURS_SQL, placeIds, zones, days);
  for (const r of rows) {
    const readings = Number(r.readings);
    if (!(readings > 0)) continue;
    const share = Number(r.full_readings) / readings;
    if (share < FULL_SHARE_MIN) continue;
    if (!byVenue.has(r.venue_place_id)) byVenue.set(r.venue_place_id, []);
    byVenue.get(r.venue_place_id).push({ dow: Number(r.dow), hour: Number(r.hour), share: Math.round(share * 100) / 100 });
  }
  for (const list of byVenue.values()) list.sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  return { byVenue, fellBack };
}

/**
 * GET /tables/stats?days=N: { days, seatings, turn_minutes: { median,
 * by_hour: [{ dow, hour, median, seatings }] }, waited_share,
 * clear_minutes_median, full_hours: [{ dow, hour, share }], timeZone }.
 * seatings is the closed seatings in the window; every median, the waited
 * share and the clear median are null under MIN_SEATINGS_FOR_MEDIAN (overall,
 * or in that hour of that weekday; the clear median counts the seatings
 * whose clear was seen). timeZone is the venue's IANA zone the weekdays and
 * hours are on, or null when they are in UTC (no zone known, or Postgres
 * refused it): never the string 'UTC', which a client would read as a clock
 * the venue keeps.
 */
async function tableStats(placeId, days = TURN_WINDOW_DAYS) {
  const zones = await venueTimeZones([placeId]);
  const [turns, full] = await Promise.all([
    turnMedians([placeId], zones, days),
    fullHours([placeId], zones, days),
  ]);
  const venue = turns.byVenue.get(placeId) || null;
  const all = venue ? venue.overall : { seatings: 0, median: null, waited_share: null, cleared: 0, clear_median: null };
  const enough = all.seatings >= MIN_SEATINGS_FOR_MEDIAN;
  const byHour = venue ? [...venue.cells.values()] : [];
  byHour.sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  const fellBack = turns.fellBack || full.fellBack;
  return {
    days,
    seatings: all.seatings,
    turn_minutes: {
      median: enough ? round1(all.median) : null,
      by_hour: byHour.map((c) => ({
        dow: c.dow,
        hour: c.hour,
        median: c.seatings >= MIN_SEATINGS_FOR_MEDIAN ? round1(c.median) : null,
        seatings: c.seatings,
      })),
    },
    waited_share: enough && all.waited_share !== null ? Math.round(all.waited_share * 1000) / 1000 : null,
    clear_minutes_median: all.cleared >= MIN_SEATINGS_FOR_MEDIAN ? round1(all.clear_median) : null,
    full_hours: full.byVenue.get(placeId) || [],
    timeZone: fellBack ? null : (zones.get(placeId) || null),
  };
}

// ---------------------------------------------------------------------------
// The owner's two switches: GET and PUT /tables/settings.
//
// Both read and written for the VERIFIED owner of the place only, in the one
// statement each: a row comes back only when the caller's claim on the place
// is verified, so the route answers its owner refusal on an empty result
// without a lookup of its own. alerts is venue_profiles.notification_prefs
// key `tables` (absent means on, the rule services/sensorTables.js reads it
// by; routes/venueProfile.js merges the same key from the dashboard's
// Settings), show_in_app is venue_profiles.tables_in_app (migration 131). The
// write merges the one key into the prefs object (jsonb ||), as the profile
// route does, so the owner's other switches are left alone, and a prefs
// column holding anything but an object starts from empty rather than
// failing the save.
// ---------------------------------------------------------------------------
const TABLE_SETTINGS_READ_SQL = `
  SELECT tables_in_app, notification_prefs
    FROM venue_profiles
   WHERE user_id = $1 AND google_place_id = $2 AND verified = true
   LIMIT 1`;

const TABLE_SETTINGS_WRITE_SQL = `
  UPDATE venue_profiles
     SET tables_in_app = COALESCE($3::boolean, tables_in_app),
         notification_prefs = CASE WHEN $4::boolean IS NULL THEN notification_prefs
                                   ELSE (CASE WHEN jsonb_typeof(notification_prefs) = 'object'
                                              THEN notification_prefs ELSE '{}'::jsonb END)
                                        || jsonb_build_object('tables', $4::boolean) END,
         updated_at = NOW()
   WHERE user_id = $1 AND google_place_id = $2 AND verified = true
   RETURNING tables_in_app, notification_prefs`;

function settingsView(row) {
  return { show_in_app: row.tables_in_app !== false, alerts: wantsTableAlerts(row.notification_prefs) };
}

/** { show_in_app, alerts } for the caller's verified claim on the place, or null. */
async function readTableSettings(callerId, placeId) {
  const { rows } = await pool.query(TABLE_SETTINGS_READ_SQL, [callerId, placeId]);
  return rows.length ? settingsView(rows[0]) : null;
}

/**
 * Write the switches the caller sent (each true, false or null for "leave
 * it") and resolve to the settings as saved, or null when the caller is not
 * the verified owner of the place.
 */
async function writeTableSettings(callerId, placeId, { showInApp = null, alerts = null }) {
  const { rows } = await pool.query(TABLE_SETTINGS_WRITE_SQL, [callerId, placeId, showInApp, alerts]);
  return rows.length ? settingsView(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// THE PUBLIC SUMMARY: what the Flock app may know about a venue's tables.
//
// COUNTS AND MINUTES, NOTHING ELSE. How many tables are free of how many, how
// many the venue has in all, whether a party of N can sit now, how long it
// likely waits otherwise, and which hours of the week the tables are usually
// all taken. No table number, no unit id, no per-table state leaves here:
// the app is read by everyone, and which table a party is at is the owner's
// business and nobody else's.
//
// NO DATA AND HIDDEN LOOK THE SAME. A venue with no fresh floor (no rows, or
// none inside SUMMARY_MAX_AGE_HOURS) and a venue whose owner turned "show
// tables in the Flock app" off are both simply absent from the answer, and
// the single-venue route answers 404 for both in the same words, so nobody
// can tell from outside whether a venue has tables it chose not to show. A
// floor past TABLES_STALE_AFTER_MINUTES but inside the day is served with
// stale true, as the owner's floor is, and with the counts of its live rows
// only (none, when every unit is dark: a stale floor says nothing is known
// to be open, and says it is stale).
//
// WHAT FITS, AND WHAT NOBODY KNOWS. fits_now is true when a free table is
// known to seat the party, false when none is free or every free table is
// known too small, and null when tables are free but whether one seats the
// party is not known (no seat count, no party that size seen, and the party
// bigger than the unknown-table default). wait_minutes is null with null:
// a party that may not have to wait is not told how long it will. timeZone
// is the venue's zone, or null when the busy hours are UTC weekdays and
// hours, so the app can say which clock they are on or say nothing.
//
// ONE STATEMENT PER QUESTION, however many venues are asked about: the
// floors, then (for the venues that have one) the switch, the zones, the
// medians and the busy hours, each over the whole list.
// ---------------------------------------------------------------------------
const HIDDEN_IN_APP_SQL = `
  SELECT google_place_id
    FROM venue_profiles
   WHERE google_place_id = ANY($1::varchar[])
     AND verified = true
     AND tables_in_app = false`;

async function hiddenInApp(placeIds) {
  const { rows } = await pool.query(HIDDEN_IN_APP_SQL, [placeIds]);
  return new Set(rows.map((r) => r.google_place_id));
}

/**
 * The public summaries of `placeIds` for a party of `party`: a plain object
 * keyed by place id, each { open, total, party, fits_now, wait_minutes,
 * busy_hours: [{ dow, hour }], timeZone, updated_at, stale }. open and total
 * count the live units' tables; fits_now is true, false or null and
 * wait_minutes null whenever it is not false; timeZone is the IANA zone the
 * busy hours are on, or null for UTC. A venue without a fresh floor, or
 * whose owner hides its tables from the app, is absent.
 */
async function publicSummaries(placeIds, party = PUBLIC_PARTY_DEFAULT, nowMs = Date.now()) {
  const out = {};
  const ids = [...new Set(placeIds)];
  if (!ids.length) return out;
  const floors = await readFloors(ids);
  const fresh = [...floors.entries()]
    .filter(([, f]) => nowMs - new Date(f.newest.updated_at).getTime() <= SUMMARY_MAX_AGE_HOURS * 3600 * 1000)
    .map(([id]) => id);
  if (!fresh.length) return out;
  const hidden = await hiddenInApp(fresh);
  const shown = fresh.filter((id) => !hidden.has(id));
  if (!shown.length) return out;
  const zones = await venueTimeZones(shown);
  const [turns, full] = await Promise.all([turnMedians(shown, zones), fullHours(shown, zones)]);
  for (const id of shown) {
    const floor = floors.get(id);
    const zone = zones.get(id) || null;
    const kept = liveRows(floor.kept);
    // Each read's cells are looked up in the clock they were folded in: UTC
    // after a 22023 fallback, whatever zone the venue has.
    const likely = likelyByTable(kept, turns.fellBack ? null : zone, turns.byVenue.get(id) || null);
    const wait = waitFor(kept, party, likely, nowMs);
    out[id] = {
      open: kept.filter((r) => r.state === 'f').length,
      total: kept.length,
      party,
      fits_now: wait.open_now,
      wait_minutes: wait.minutes,
      busy_hours: (full.byVenue.get(id) || []).map((c) => ({ dow: c.dow, hour: c.hour })),
      timeZone: full.fellBack ? null : zone,
      ...floorClock(floor),
    };
  }
  return out;
}

module.exports = {
  TURN_WINDOW_DAYS,
  STATS_DAYS_MIN,
  STATS_DAYS_MAX,
  SEATS_WINDOW_DAYS,
  MIN_SEATINGS_FOR_MEDIAN,
  UNKNOWN_SEATS_FIT_UP_TO,
  WAIT_PARTIES,
  FULL_SHARE_MIN,
  SUMMARY_MAX_AGE_HOURS,
  PUBLIC_PARTY_DEFAULT,
  PUBLIC_PARTY_MAX,
  SUMMARIES_MAX_PLACES,
  venueTimeZone,
  venueTimeZones,
  turnMedians,
  medianFor,
  likelyFreeAt,
  readFloors,
  liveRows,
  seatsOf,
  fits,
  ownerFloor,
  tableWaits,
  tableIncoming,
  tableStats,
  fullHours,
  readTableSettings,
  writeTableSettings,
  publicSummaries,
};
