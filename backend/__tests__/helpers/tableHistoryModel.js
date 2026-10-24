'use strict';
// ---------------------------------------------------------------------------
// A model of the statements services/tableHistory.js sends, for the suites
// that drive the owner's table routes and the public summary without a
// database: sensorTables.test.js (which needs the floor read to keep
// answering once it joined the seatings) and sensorTableHistory.test.js.
//
// Like helpers/sensorStoreModel.js it models what each statement DOES against
// the suite's own arrays, so the twenty-seating floor, the weekday-and-hour
// cells and the public "no data or hidden" rule are enforced by the model
// rather than scripted per test. The real statements run against Postgres in
// sensorTableHistoryStatement.test.js, and a rule changed in one place has to
// be changed in the other in the same commit.
//
// The venue's clock is folded with utils/venueZone.js (ICU), where Postgres
// folds with AT TIME ZONE; the two carry the same IANA database.
// ---------------------------------------------------------------------------
const { clockInZone, civilTime } = require('../../utils/venueZone');

const DAY = 24 * 3600 * 1000;

// The floor read (services/tableHistory.js TABLE_FLOOR_SQL), by its head.
const FLOOR_READ = /^SELECT s\.venue_place_id, s\.sensor_device_id, s\.table_no, .* FROM sensor_table_states s LEFT JOIN \( SELECT g\.venue_place_id, g\.sensor_device_id, g\.table_no, NULLIF\(MAX\(g\.party_max\), 0\) AS party_max FROM sensor_table_seatings g WHERE g\.venue_place_id = ANY\(\$1::varchar\[\]\)/;
const ZONES_READ = /^SELECT google_place_id, timezone FROM ml_venues WHERE google_place_id = ANY\(\$1::varchar\[\]\)$/;
const MEDIANS_READ = /^SELECT g\.venue_place_id, g\.dow, g\.hour, COUNT\(\*\)::int AS seatings, percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY g\.turn_minutes\) AS median/;
const FULL_HOURS_READ = /^SELECT v\.venue_place_id, EXTRACT\(DOW FROM \(v\.recorded_at AT TIME ZONE z\.zone\)\)::int AS dow/;
const HIDDEN_READ = /^SELECT google_place_id FROM venue_profiles WHERE google_place_id = ANY\(\$1::varchar\[\]\) AND verified = true AND tables_in_app = false$/;
const SETTINGS_READ = /^SELECT tables_in_app, notification_prefs FROM venue_profiles WHERE user_id = \$1 AND google_place_id = \$2 AND verified = true LIMIT 1$/;
const SETTINGS_WRITE = /^UPDATE venue_profiles SET tables_in_app = COALESCE\(\$3::boolean, tables_in_app\), notification_prefs = CASE WHEN \$4::boolean IS NULL THEN notification_prefs ELSE .* \|\| jsonb_build_object\('tables', \$4::boolean\) END, updated_at = NOW\(\) WHERE user_id = \$1 AND google_place_id = \$2 AND verified = true RETURNING tables_in_app, notification_prefs$/;
// The incoming feed (services/incomingFlocks.js), the way the dashboard's own
// suites recognise it.
const INCOMING_READ = /FROM flocks f WHERE/;

const ms = (d) => new Date(d).getTime();

// percentile_cont(0.5): the middle value, or the mean of the two middle ones.
function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) / 2;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? v[lo] : (v[lo] + v[hi]) / 2;
}

// Postgres answers the zone's weekday, hour and date for an instant; so does
// ICU. A zone neither knows is the error the service repeats in UTC,
// modelled as a thrown 22023.
function fold(at, zone) {
  const clock = clockInZone(ms(at), zone);
  const civil = civilTime(ms(at), zone);
  if (!clock || !civil) {
    const err = new Error(`time zone "${zone}" not recognized`);
    err.code = '22023';
    throw err;
  }
  return { dow: clock.day, hour: clock.hour, date: `${civil.year}-${civil.month}-${civil.day}` };
}

/**
 * TABLE_FLOOR_SQL over store.tableStates and store.seatings: every unit's rows
 * at the places asked about, by place, number, newest first within a number
 * and then by unit, each flagged stale past the window and carrying the
 * largest party seen at the table inside the seats window (null for none or
 * for parties of nobody), from the seatings of that unit and table AT THAT
 * VENUE only. Parameters: $1 place ids, $2 the stale window in minutes, $3
 * the seats window in days.
 */
function floorModel(store, params) {
  const [ids, minutes, days] = params;
  const seatings = Array.isArray(store.seatings) ? store.seatings : [];
  const since = Date.now() - days * DAY;
  return store.tableStates
    .filter((r) => ids.includes(r.venue_place_id))
    .sort((a, b) => a.venue_place_id.localeCompare(b.venue_place_id) || (a.table_no - b.table_no)
      || (b.updated_at - a.updated_at) || a.sensor_device_id.localeCompare(b.sensor_device_id))
    .map((r) => {
      let seen = null;
      for (const g of seatings) {
        if (g.sensor_device_id !== r.sensor_device_id || g.table_no !== r.table_no) continue;
        if (g.venue_place_id !== r.venue_place_id || !ids.includes(g.venue_place_id) || ms(g.seated_at) < since) continue;
        seen = Math.max(seen ?? 0, g.party_max);
      }
      return {
        venue_place_id: r.venue_place_id,
        sensor_device_id: r.sensor_device_id,
        table_no: r.table_no, people: r.people, state: r.state, state_since: r.state_since,
        seats: r.seats ?? null, updated_at: r.updated_at,
        stale: r.updated_at.getTime() < Date.now() - minutes * 60 * 1000,
        party_max_seen: seen === null || seen === 0 ? null : seen,
      };
    });
}

/**
 * TURN_MEDIANS_SQL over store.seatings: the closed seatings of each place in
 * the window no longer than the bound, folded by its zone, as the cells and
 * the overall row GROUPING SETS gives (dow and hour null on the overall row).
 * Parameters: $1 place ids, $2 their zones, $3 days, $4 the longest seating
 * that counts, in hours. numeric comes back as a string, as pg hands
 * AVG(numeric) back; percentile_cont as a number.
 */
function mediansModel(store, params) {
  const [ids, zones, days, maxHours] = params;
  const since = Date.now() - days * DAY;
  const longest = maxHours * 3600 * 1000;
  const rows = [];
  ids.forEach((id, i) => {
    const closed = (store.seatings || []).filter((g) => g.venue_place_id === id && g.left_at !== null && ms(g.seated_at) >= since
      && ms(g.left_at) - ms(g.seated_at) <= longest);
    if (closed.length === 0) return;
    const cells = new Map();
    for (const g of closed) {
      const { dow, hour } = fold(g.seated_at, zones[i]);
      const key = `${dow}:${hour}`;
      if (!cells.has(key)) cells.set(key, { dow, hour, list: [] });
      cells.get(key).list.push(g);
    }
    const turn = (g) => (ms(g.left_at) - ms(g.seated_at)) / 60000;
    const clear = (g) => (g.cleared_at === null ? null : (ms(g.cleared_at) - ms(g.left_at)) / 60000);
    const row = (list, dow, hour) => ({
      venue_place_id: id,
      dow,
      hour,
      seatings: list.length,
      median: median(list.map(turn)),
      waited_share: (list.filter((g) => g.waited).length / list.length).toFixed(20),
      cleared: list.filter((g) => g.cleared_at !== null).length,
      clear_median: median(list.map(clear)),
    });
    for (const c of cells.values()) rows.push(row(c.list, c.dow, c.hour));
    rows.push(row(closed, null, null));
  });
  return rows;
}

/**
 * FULL_HOURS_SQL over store.readings: readings with tables in the window,
 * per place, folded by its zone, with how many had every table in use and
 * how many distinct dates (on that clock) the cell's readings fall on.
 */
function fullHoursModel(store, params) {
  const [ids, zones, days] = params;
  const since = Date.now() - days * DAY;
  const cells = new Map();
  for (const r of store.readings) {
    const i = ids.indexOf(r.venue_place_id);
    if (i < 0 || !(r.tables_total > 0) || ms(r.recorded_at) < since) continue;
    const { dow, hour, date } = fold(r.recorded_at, zones[i]);
    const key = `${r.venue_place_id}|${dow}:${hour}`;
    if (!cells.has(key)) cells.set(key, { venue_place_id: r.venue_place_id, dow, hour, readings: 0, dates: new Set(), full_readings: 0 });
    const c = cells.get(key);
    c.readings += 1;
    c.dates.add(date);
    if (r.tables_occupied === r.tables_total) c.full_readings += 1;
  }
  return [...cells.values()].map(({ dates, ...c }) => ({ ...c, days: dates.size }));
}

// The incoming feed over store.flocks, the way incomingFlocksWindow.test.js
// models it: plans whose own venue_id is the place, inside the window,
// soonest first, twenty at most. member_count is a bigint, so a string, and
// event_time comes back the way node-postgres reads a TIMESTAMP WITHOUT TIME
// ZONE: a Date whose LOCAL fields are the stored UTC wall clock, which is the
// instant itself only on a UTC server (services/tableHistory.js
// naiveUtcInstant rebuilds it; the fixture holds the true instant).
function asDriverReadsNaive(instant) {
  const d = new Date(instant);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

function incomingModel(store, params) {
  const [placeId] = params;
  const now = Date.now();
  return (store.flocks || [])
    .filter((f) => f.venue_id === placeId && (f.status == null || ['planning', 'confirmed'].includes(f.status)))
    .filter((f) => f.event_time && ms(f.event_time) > now - 12 * 3600 * 1000 && ms(f.event_time) < now + 7 * DAY)
    .sort((a, b) => ms(a.event_time) - ms(b.event_time))
    .slice(0, 20)
    .map((f) => ({ id: f.id, event_time: asDriverReadsNaive(f.event_time), status: f.status, member_count: String(f.member_count), guest_count: f.guest_count || 0 }));
}

/**
 * Answer one of this module's statements against `store` ({ tableStates,
 * seatings, readings, venueProfiles, mlVenues, flocks }), or return null when
 * `flat` (the whitespace-collapsed SQL) is not one of them. Throws the 22023
 * Postgres raises for a zone it does not know.
 */
function dispatchTableHistory(store, flat, params) {
  if (FLOOR_READ.test(flat)) {
    const rows = floorModel(store, params);
    return { rows, rowCount: rows.length };
  }
  if (ZONES_READ.test(flat)) {
    const rows = (store.mlVenues || []).filter((v) => params[0].includes(v.google_place_id))
      .map((v) => ({ google_place_id: v.google_place_id, timezone: v.timezone }));
    return { rows, rowCount: rows.length };
  }
  if (MEDIANS_READ.test(flat)) {
    const rows = mediansModel(store, params);
    return { rows, rowCount: rows.length };
  }
  if (FULL_HOURS_READ.test(flat)) {
    const rows = fullHoursModel(store, params);
    return { rows, rowCount: rows.length };
  }
  if (HIDDEN_READ.test(flat)) {
    const rows = (store.venueProfiles || [])
      .filter((v) => params[0].includes(v.google_place_id) && v.verified === true && v.tables_in_app === false)
      .map((v) => ({ google_place_id: v.google_place_id }));
    return { rows, rowCount: rows.length };
  }
  if (SETTINGS_READ.test(flat)) {
    const hit = (store.venueProfiles || []).find((v) => v.user_id === params[0] && v.google_place_id === params[1] && v.verified === true);
    const rows = hit ? [{ tables_in_app: hit.tables_in_app !== false, notification_prefs: hit.notification_prefs ?? null }] : [];
    return { rows, rowCount: rows.length };
  }
  if (SETTINGS_WRITE.test(flat)) {
    const [callerId, placeId, showInApp, alerts] = params;
    const hit = (store.venueProfiles || []).find((v) => v.user_id === callerId && v.google_place_id === placeId && v.verified === true);
    if (!hit) return { rows: [], rowCount: 0 };
    if (showInApp !== null && showInApp !== undefined) hit.tables_in_app = showInApp;
    if (alerts !== null && alerts !== undefined) {
      const prefs = hit.notification_prefs && typeof hit.notification_prefs === 'object' && !Array.isArray(hit.notification_prefs)
        ? hit.notification_prefs : {};
      hit.notification_prefs = { ...prefs, tables: alerts };
    }
    return { rows: [{ tables_in_app: hit.tables_in_app !== false, notification_prefs: hit.notification_prefs ?? null }], rowCount: 1 };
  }
  if (INCOMING_READ.test(flat)) {
    const rows = incomingModel(store, params);
    return { rows, rowCount: rows.length };
  }
  return null;
}

module.exports = {
  FLOOR_READ, ZONES_READ, MEDIANS_READ, FULL_HOURS_READ, HIDDEN_READ, SETTINGS_READ, SETTINGS_WRITE, INCOMING_READ,
  floorModel, mediansModel, fullHoursModel, incomingModel, median, dispatchTableHistory,
};
