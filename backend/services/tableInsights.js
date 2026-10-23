'use strict';
// ---------------------------------------------------------------------------
// TABLE INSIGHTS: what the seatings say, turned into sentences and facts.
// ---------------------------------------------------------------------------
// services/tableHistory.js reads the seatings for the owner's table routes
// (the floor, the stats, the waits). This module is the layer above it that
// the owner READS rather than looks at:
//
//   lastNightSummary   "Last night at your tables": a few sentences built from
//                      counts and medians, no model call (the owner route in
//                      routes/tableInsights.js, the advisor, the digest)
//   weekFigures        the last seven days for the Monday digest's "Your
//                      tables" section (tableHistory.tableStats, read only)
//   turnsByDay         typical turn and waited share for each weekday
//   tablesWaitingMost  which table numbers most often waited for a server
//   freeForecast       for a weekday and hour, the share of past weeks a table
//                      was free (owner side only; never on a public route)
//   buildTableFacts    all of the above as advisor facts with provenance
//   buildDigestTableFacts  the digest's section, or null when the venue had no
//                      seatings in the week
//
// NOTHING HERE IS ABOUT A PERSON. A seating is a table number, four times and
// a head count (migration 131). Every figure below is venue wide or per table
// number, and the per-table figures go to the venue's verified owner only.
//
// NOTHING IS CLAIMED PAST THE DATA. A median is said only over
// MIN_SEATINGS_FOR_MEDIAN closed seatings (tableHistory's floor), a forecast
// only over FORECAST_MIN_WEEKS weeks with readings, and the copy says
// "typical" and "about". No em dashes in any sentence (advisorFacts'
// assertCleanCopy throws on one when a fact is built).
//
// Every statement binds its parameters with one cast each, the same way every
// time ($1 varchar place, $2 text zone, $3 timestamptz now, $4 int window).
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const tableHistory = require('./tableHistory');

const { MIN_SEATINGS_FOR_MEDIAN, FULL_SHARE_MIN } = tableHistory;

const TURNS_WINDOW_DAYS = 28;
const WEEK_DAYS = 7;
const FORECAST_WEEKS = 8;
const FORECAST_MIN_WEEKS = 4;
// A table number is named as "often waited" only over this many seatings.
const TABLE_MIN_SEATINGS = 10;
const TABLES_NAMED_MAX = 3;
const HOURS_NAMED_MAX = 6;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hourWords(h) {
  const n = ((Number(h) % 24) + 24) % 24;
  const twelve = n % 12 === 0 ? 12 : n % 12;
  return `${twelve} ${n < 12 ? 'AM' : 'PM'}`;
}

// [19, 20, 21, 23] -> ['7 PM to 10 PM', '11 PM to 12 AM']: runs of whole hours.
function hourRanges(hours) {
  const sorted = [...new Set(hours.map(Number))].sort((a, b) => a - b);
  const out = [];
  let start = null;
  let prev = null;
  for (const h of sorted) {
    if (start === null) { start = h; prev = h; continue; }
    if (h === prev + 1) { prev = h; continue; }
    out.push(`${hourWords(start)} to ${hourWords(prev + 1)}`);
    start = h;
    prev = h;
  }
  if (start !== null) out.push(`${hourWords(start)} to ${hourWords(prev + 1)}`);
  return out;
}

function listWords(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const roundMinutes = (v) => (v === null || v === undefined ? null : Math.max(1, Math.round(Number(v))));
const percentOf = (share) => Math.round(Number(share) * 100);

// The venue's zone from the corpus, or UTC with timeZone null (the contract
// tableHistory's stats follow: null when the zone is not known).
async function zoneFor(placeId) {
  const zone = await tableHistory.venueTimeZone(placeId);
  return { sqlZone: zone || 'UTC', timeZone: zone || null };
}

// One read in the venue's zone; a zone Postgres refuses (22023) is read again
// in UTC and reported as unknown, the same posture tableHistory takes.
async function queryInZone(sql, placeId, zone, nowIso, extra = []) {
  try {
    const { rows } = await pool.query(sql, [placeId, zone.sqlZone, nowIso, ...extra]);
    return { rows, timeZone: zone.timeZone };
  } catch (err) {
    if (err.code !== '22023' || zone.sqlZone === 'UTC') throw err;
    const { rows } = await pool.query(sql, [placeId, 'UTC', nowIso, ...extra]);
    return { rows, timeZone: null };
  }
}

const utcNote = (timeZone) => (timeZone ? '' : ' Hours are in UTC, because we do not know your time zone yet.');

// ---------------------------------------------------------------------------
// I2. Last night at your tables.
// ---------------------------------------------------------------------------
const LAST_NIGHT_SEATINGS_SQL = `
  SELECT COUNT(*)::int AS seatings,
         COUNT(*) FILTER (WHERE s.waited)::int AS waited,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.left_at - s.seated_at)) / 60) AS turn_median,
         ((($3::timestamptz AT TIME ZONE $2::text)::date) - 1) AS day
    FROM sensor_table_seatings s
   WHERE s.venue_place_id = $1::varchar
     AND s.left_at IS NOT NULL
     AND s.seated_at >= $3::timestamptz - INTERVAL '3 days'
     AND (s.seated_at AT TIME ZONE $2::text)::date = (($3::timestamptz AT TIME ZONE $2::text)::date) - 1`;

const LAST_NIGHT_FULL_SQL = `
  SELECT EXTRACT(HOUR FROM (v.recorded_at AT TIME ZONE $2::text))::int AS hour,
         COUNT(*)::int AS readings,
         COUNT(*) FILTER (WHERE v.tables_occupied = v.tables_total)::int AS full_readings
    FROM venue_sensor_data v
   WHERE v.venue_place_id = $1::varchar
     AND v.tables_total > 0
     AND v.recorded_at >= $3::timestamptz - INTERVAL '3 days'
     AND (v.recorded_at AT TIME ZONE $2::text)::date = (($3::timestamptz AT TIME ZONE $2::text)::date) - 1
   GROUP BY 1`;

function isoDay(v) {
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return v ? String(v).slice(0, 10) : null;
}

/**
 * The venue's previous local day at its tables:
 * { date, timeZone, seatings, waited, turn_minutes, full_hours: [hour],
 *   sentences: [string], text }. Deterministic: every sentence is built from
 * the counts here. turn_minutes is null under MIN_SEATINGS_FOR_MEDIAN.
 */
async function lastNightSummary(placeId, now = new Date()) {
  const zone = await zoneFor(placeId);
  const nowIso = new Date(now).toISOString();
  const [seat, full] = await Promise.all([
    queryInZone(LAST_NIGHT_SEATINGS_SQL, placeId, zone, nowIso),
    queryInZone(LAST_NIGHT_FULL_SQL, placeId, zone, nowIso),
  ]);
  const row = seat.rows[0] || {};
  const seatings = Number(row.seatings) || 0;
  const waited = Number(row.waited) || 0;
  const turn = seatings >= MIN_SEATINGS_FOR_MEDIAN ? roundMinutes(row.turn_median) : null;
  const fullHours = full.rows
    .filter((r) => Number(r.readings) > 0 && Number(r.full_readings) / Number(r.readings) >= FULL_SHARE_MIN)
    .map((r) => Number(r.hour))
    .sort((a, b) => a - b);
  const timeZone = seat.timeZone && full.timeZone ? seat.timeZone : null;

  const sentences = [];
  if (seatings === 0) {
    sentences.push('No seatings were recorded at your tables yesterday.');
  } else {
    sentences.push(`Your tables had ${seatings} ${seatings === 1 ? 'seating' : 'seatings'} yesterday.`);
    if (turn !== null) sentences.push(`A typical party sat for about ${turn} minutes.`);
    sentences.push(waited === 0
      ? 'No seating waited past your wait limit for a server.'
      : `${waited} of ${seatings} seatings waited past your wait limit for a server.`);
  }
  if (fullHours.length) {
    sentences.push(`Every table was in use for most of ${listWords(hourRanges(fullHours))}.${utcNote(timeZone)}`);
  }
  return {
    date: isoDay(row.day),
    timeZone,
    seatings,
    waited,
    turn_minutes: turn,
    full_hours: fullHours,
    sentences,
    text: sentences.join(' '),
  };
}

// ---------------------------------------------------------------------------
// S7. The last seven days (tableHistory.tableStats over a seven day window).
// ---------------------------------------------------------------------------
async function weekFigures(placeId) {
  return tableHistory.tableStats(placeId, WEEK_DAYS);
}

// ---------------------------------------------------------------------------
// I1/I4. Turn and wait by weekday, and the table numbers that waited most.
// ---------------------------------------------------------------------------
const TURNS_BY_DAY_SQL = `
  SELECT EXTRACT(DOW FROM (s.seated_at AT TIME ZONE $2::text))::int AS dow,
         COUNT(*)::int AS seatings,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.left_at - s.seated_at)) / 60) AS turn_median,
         AVG(CASE WHEN s.waited THEN 1.0 ELSE 0.0 END) AS waited_share
    FROM sensor_table_seatings s
   WHERE s.venue_place_id = $1::varchar
     AND s.left_at IS NOT NULL
     AND s.seated_at >= $3::timestamptz - ($4::int * INTERVAL '1 day')
     AND s.seated_at < $3::timestamptz
   GROUP BY 1
   ORDER BY 1`;

/** [{ dow, seatings, turn_minutes, waited_percent }] (nulls under the floor) and timeZone. */
async function turnsByDay(placeId, now = new Date(), days = TURNS_WINDOW_DAYS) {
  const zone = await zoneFor(placeId);
  const { rows, timeZone } = await queryInZone(TURNS_BY_DAY_SQL, placeId, zone, new Date(now).toISOString(), [days]);
  return {
    timeZone,
    days: rows.map((r) => {
      const seatings = Number(r.seatings);
      const enough = seatings >= MIN_SEATINGS_FOR_MEDIAN;
      return {
        dow: Number(r.dow),
        seatings,
        turn_minutes: enough ? roundMinutes(r.turn_median) : null,
        waited_percent: enough && r.waited_share !== null ? percentOf(r.waited_share) : null,
      };
    }),
  };
}

const TABLES_WAITED_SQL = `
  SELECT s.table_no,
         COUNT(*)::int AS seatings,
         COUNT(*) FILTER (WHERE s.waited)::int AS waited
    FROM sensor_table_seatings s
   WHERE s.venue_place_id = $1::varchar
     AND s.left_at IS NOT NULL
     AND s.seated_at >= $2::timestamptz - ($3::int * INTERVAL '1 day')
     AND s.seated_at < $2::timestamptz
   GROUP BY s.table_no`;

/** Up to three table numbers whose seatings most often waited, each over TABLE_MIN_SEATINGS. */
async function tablesWaitingMost(placeId, now = new Date(), days = TURNS_WINDOW_DAYS) {
  const { rows } = await pool.query(TABLES_WAITED_SQL, [placeId, new Date(now).toISOString(), days]);
  return rows
    .map((r) => ({ table: Number(r.table_no), seatings: Number(r.seatings), waited: Number(r.waited) }))
    .filter((t) => t.seatings >= TABLE_MIN_SEATINGS && t.waited > 0)
    .map((t) => ({ ...t, waited_percent: percentOf(t.waited / t.seatings) }))
    .sort((a, b) => b.waited_percent - a.waited_percent || b.seatings - a.seatings || a.table - b.table)
    .slice(0, TABLES_NAMED_MAX);
}

// ---------------------------------------------------------------------------
// I3. How often a table was free at a weekday and hour.
//
// From the readings (tables_total, tables_occupied, migration 130): an hour on
// one day counts as "a table was free" when at least half its readings had a
// table not in use, the same half FULL_SHARE_MIN draws for a full hour. The
// share is over the weeks that had readings in that hour, and nothing is said
// under FORECAST_MIN_WEEKS of them. A record of past weeks, not a promise.
// ---------------------------------------------------------------------------
const FREE_BY_HOUR_SQL = `
  SELECT d.dow, d.hour,
         COUNT(*)::int AS weeks,
         COUNT(*) FILTER (WHERE d.free_share >= 0.5)::int AS free_weeks
    FROM (
      SELECT (v.recorded_at AT TIME ZONE $2::text)::date AS day,
             EXTRACT(DOW FROM (v.recorded_at AT TIME ZONE $2::text))::int AS dow,
             EXTRACT(HOUR FROM (v.recorded_at AT TIME ZONE $2::text))::int AS hour,
             AVG(CASE WHEN v.tables_occupied < v.tables_total THEN 1.0 ELSE 0.0 END) AS free_share
        FROM venue_sensor_data v
       WHERE v.venue_place_id = $1::varchar
         AND v.tables_total > 0
         AND v.recorded_at >= $3::timestamptz - ($4::int * INTERVAL '1 day')
         AND v.recorded_at < $3::timestamptz
       GROUP BY 1, 2, 3
    ) d
   GROUP BY d.dow, d.hour`;

/** Every weekday-hour with at least FORECAST_MIN_WEEKS weeks: [{ dow, hour, weeks, free_weeks, share }]. */
async function freeByHour(placeId, now = new Date(), weeks = FORECAST_WEEKS) {
  const zone = await zoneFor(placeId);
  const { rows, timeZone } = await queryInZone(FREE_BY_HOUR_SQL, placeId, zone, new Date(now).toISOString(), [weeks * 7]);
  const cells = rows
    .map((r) => ({ dow: Number(r.dow), hour: Number(r.hour), weeks: Number(r.weeks), free_weeks: Number(r.free_weeks) }))
    .filter((c) => c.weeks >= FORECAST_MIN_WEEKS)
    .map((c) => ({ ...c, share: Math.round((c.free_weeks / c.weeks) * 100) / 100 }))
    .sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  return { timeZone, cells };
}

/**
 * For one weekday (0 Sunday) and hour: { dow, hour, weeks, free_weeks, share,
 * timeZone }, or share null when fewer than FORECAST_MIN_WEEKS weeks had
 * readings in that hour.
 */
async function freeForecast(placeId, dow, hour, now = new Date()) {
  const { timeZone, cells } = await freeByHour(placeId, now);
  const cell = cells.find((c) => c.dow === Number(dow) && c.hour === Number(hour));
  if (!cell) return { dow: Number(dow), hour: Number(hour), weeks: null, free_weeks: null, share: null, timeZone };
  return { ...cell, timeZone };
}

// ---------------------------------------------------------------------------
// Advisor facts. Built through advisorFacts.makeFact (required lazily: that
// module requires this one lazily too, so the cycle never closes at load).
// Source 'table_sensor': the venue's own table unit, measured.
// ---------------------------------------------------------------------------
function factKit() {
  // eslint-disable-next-line global-require
  const { makeFact, makeRefusal } = require('./advisorFacts');
  return { makeFact, makeRefusal };
}

const SOURCE = 'table_sensor';

function lastNightFact(summary, asOf) {
  const { makeFact } = factKit();
  return makeFact({
    id: 'tables_last_night',
    value: { seatings: summary.seatings, waitedSeatings: summary.waited, turnMinutes: summary.turn_minutes },
    source: SOURCE,
    asOf: summary.date || asOf,
    label: `Last night at your tables: ${summary.text}`,
  });
}

function weekFacts(stats, asOf) {
  const { makeFact } = factKit();
  const out = [];
  const unknownZone = !stats.timeZone || stats.timeZone === 'UTC';
  out.push(makeFact({
    id: 'tables_week_seatings',
    value: { seatings: stats.seatings, days: stats.days },
    source: SOURCE,
    asOf,
    label: `Your tables had ${stats.seatings} ${stats.seatings === 1 ? 'seating' : 'seatings'} in the last ${stats.days} days.`,
  }));
  if (stats.full_hours.length) {
    const byDay = new Map();
    for (const c of stats.full_hours) {
      if (!byDay.has(c.dow)) byDay.set(c.dow, []);
      byDay.get(c.dow).push(c.hour);
    }
    const parts = [...byDay.entries()].map(([dow, hours]) => `${DAY_NAMES[dow]} ${listWords(hourRanges(hours))}`);
    out.push(makeFact({
      id: 'tables_full_hours',
      value: { hours: stats.full_hours.length, when: parts },
      source: SOURCE,
      asOf,
      label: `Every table was in use for most of ${listWords(parts.slice(0, HOURS_NAMED_MAX))}.${unknownZone ? ' Hours are in UTC, because we do not know your time zone yet.' : ''}`,
    }));
  }
  if (stats.turn_minutes.median !== null) {
    out.push(makeFact({
      id: 'tables_turn_typical',
      value: { turnMinutes: Math.round(stats.turn_minutes.median) },
      source: SOURCE,
      asOf,
      label: `A typical party sat for about ${Math.round(stats.turn_minutes.median)} minutes.`,
    }));
  }
  if (stats.waited_share !== null) {
    out.push(makeFact({
      id: 'tables_waited_share',
      value: { waitedPercent: percentOf(stats.waited_share) },
      source: SOURCE,
      asOf,
      label: `About ${percentOf(stats.waited_share)}% of seatings waited past your wait limit for a server.`,
    }));
  }
  if (stats.clear_minutes_median !== null) {
    out.push(makeFact({
      id: 'tables_clear_typical',
      value: { clearMinutes: Math.round(stats.clear_minutes_median) },
      source: SOURCE,
      asOf,
      label: `A table was typically cleared about ${Math.round(stats.clear_minutes_median)} minutes after the party left.`,
    }));
  }
  return out;
}

/**
 * The digest's "Your tables" section: last night plus the last seven days,
 * venue wide only (no table number). null when the venue had no closed
 * seating in the last seven days, so the section is simply absent.
 */
async function buildDigestTableFacts(placeId, now = new Date()) {
  const stats = await weekFigures(placeId);
  if (!stats || !(stats.seatings > 0)) return null;
  const asOf = new Date(now).toISOString().slice(0, 10);
  const summary = await lastNightSummary(placeId, now);
  const facts = [];
  if (summary.seatings > 0) facts.push(lastNightFact(summary, asOf));
  facts.push(...weekFacts(stats, asOf));
  return facts;
}

/**
 * Everything the advisor can say about a venue's tables, as facts and
 * refusals: last night, the last seven days, turn and wait by weekday, the
 * table numbers that waited most, and the hours a table was rarely free.
 * A venue with no table history gets one refusal naming what would fill it.
 */
async function buildTableFacts(ctx, { now = new Date() } = {}) {
  const { makeFact, makeRefusal } = factKit();
  const placeId = ctx && ctx.profile ? ctx.profile.google_place_id : null;
  const noTables = () => makeRefusal({
    id: 'refuse_no_table_history',
    reason: 'We have no table seatings from your venue yet.',
    whatWouldUnlock: 'A Flux unit with your tables drawn on its screen. Each seating it sees lands here.',
  });
  if (!placeId) return [noTables()];
  const asOf = new Date(now).toISOString().slice(0, 10);
  let stats28;
  let stats7;
  let summary;
  let byDay;
  let waitedTables;
  let free;
  try {
    [stats28, stats7, summary, byDay, waitedTables, free] = await Promise.all([
      tableHistory.tableStats(placeId, TURNS_WINDOW_DAYS),
      weekFigures(placeId),
      lastNightSummary(placeId, now),
      turnsByDay(placeId, now),
      tablesWaitingMost(placeId, now),
      freeByHour(placeId, now),
    ]);
  } catch (err) {
    console.error('[tableInsights] table facts read failed:', err.message);
    return [makeRefusal({
      id: 'refuse_table_read_failed',
      reason: 'We could not read your table history just now.',
      whatWouldUnlock: 'Asking again in a minute. Nothing is missing on your side.',
    })];
  }
  if (!stats28 || !(stats28.seatings > 0)) return [noTables()];

  const out = [];
  if (summary.seatings > 0) out.push(lastNightFact(summary, asOf));
  if (stats7 && stats7.seatings > 0) out.push(...weekFacts(stats7, asOf));

  const unknownZone = !byDay.timeZone;
  for (const d of byDay.days) {
    if (d.turn_minutes === null) continue;
    out.push(makeFact({
      id: `tables_turn_${DAY_NAMES[d.dow].toLowerCase()}`,
      value: { weekday: DAY_NAMES[d.dow], turnMinutes: d.turn_minutes, waitedPercent: d.waited_percent, seatings: d.seatings, days: TURNS_WINDOW_DAYS },
      source: SOURCE,
      asOf,
      label: `On ${DAY_NAMES[d.dow]}s over the last ${TURNS_WINDOW_DAYS} days, a typical party sat for about ${d.turn_minutes} minutes and about ${d.waited_percent}% of seatings waited past your wait limit for a server, from ${d.seatings} seatings.`,
    }));
  }
  if (!byDay.days.some((d) => d.turn_minutes !== null)) {
    out.push(makeRefusal({
      id: 'refuse_table_turns_by_day',
      reason: `No weekday has ${MIN_SEATINGS_FOR_MEDIAN} seatings in the last ${TURNS_WINDOW_DAYS} days yet, and we do not give a typical time from fewer.`,
      whatWouldUnlock: 'More nights with your tables drawn on the unit. Each weekday fills in on its own.',
    }));
  }
  if (stats28.full_hours.length) {
    const cells = stats28.full_hours.slice(0, HOURS_NAMED_MAX).map((c) => `${DAY_NAMES[c.dow]} ${hourWords(c.hour)}`);
    out.push(makeFact({
      id: 'tables_full_hours_month',
      value: { when: cells, days: TURNS_WINDOW_DAYS },
      source: SOURCE,
      asOf,
      label: `Over the last ${TURNS_WINDOW_DAYS} days, every table was usually in use at ${listWords(cells)}.${unknownZone ? ' Hours are in UTC, because we do not know your time zone yet.' : ''}`,
    }));
  }
  if (waitedTables.length) {
    const parts = waitedTables.map((t) => `table ${t.table} (about ${t.waited_percent}% of ${t.seatings} seatings)`);
    out.push(makeFact({
      id: 'tables_waiting_most',
      value: { tables: waitedTables.map((t) => `table ${t.table}`), days: TURNS_WINDOW_DAYS },
      source: SOURCE,
      asOf,
      label: `Over the last ${TURNS_WINDOW_DAYS} days, the tables that most often waited past your wait limit for a server were ${listWords(parts)}.`,
    }));
  }
  const rarelyFree = free.cells.filter((c) => c.share < 0.5)
    .sort((a, b) => a.share - b.share || a.dow - b.dow || a.hour - b.hour)
    .slice(0, HOURS_NAMED_MAX);
  if (rarelyFree.length) {
    const parts = rarelyFree.map((c) => `${DAY_NAMES[c.dow]} ${hourWords(c.hour)} (${c.free_weeks} of ${c.weeks} weeks)`);
    out.push(makeFact({
      id: 'tables_rarely_free',
      value: { when: rarelyFree.map((c) => `${DAY_NAMES[c.dow]} ${hourWords(c.hour)}`), weeks: FORECAST_WEEKS },
      source: SOURCE,
      asOf,
      note: 'A record of past weeks at your venue, not a promise about the next one.',
      label: `Over the last ${FORECAST_WEEKS} weeks, a table was free in fewer than half of the weeks at ${listWords(parts)}.${free.timeZone ? '' : ' Hours are in UTC, because we do not know your time zone yet.'}`,
    }));
  }
  const usuallyFree = free.cells.filter((c) => c.share >= 0.5);
  if (free.cells.length && !rarelyFree.length) {
    out.push(makeFact({
      id: 'tables_usually_free',
      value: { hours: usuallyFree.length, weeks: FORECAST_WEEKS },
      source: SOURCE,
      asOf,
      note: 'A record of past weeks at your venue, not a promise about the next one.',
      label: `Over the last ${FORECAST_WEEKS} weeks, a table was free in at least half of the weeks at every hour we have readings for.`,
    }));
  }
  if (!free.cells.length) {
    out.push(makeRefusal({
      id: 'refuse_table_free_forecast',
      reason: `We need readings from the same hour in at least ${FORECAST_MIN_WEEKS} different weeks before we say how often a table was free then.`,
      whatWouldUnlock: 'More weeks with your tables drawn on the unit. This fills in on its own.',
    }));
  }
  return out;
}

module.exports = {
  TURNS_WINDOW_DAYS,
  FORECAST_WEEKS,
  FORECAST_MIN_WEEKS,
  TABLE_MIN_SEATINGS,
  lastNightSummary,
  weekFigures,
  turnsByDay,
  tablesWaitingMost,
  freeByHour,
  freeForecast,
  buildTableFacts,
  buildDigestTableFacts,
  __test: { hourWords, hourRanges, listWords },
};
