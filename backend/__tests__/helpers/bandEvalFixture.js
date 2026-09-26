'use strict';
// ---------------------------------------------------------------------------
// THE SYNTHETIC CORPUS THE BAND REPLAY AND predictBusyness ARE COMPARED ON.
//
// Shared by __tests__/mlBandEval.test.js (replay parity, every serve mode) and
// __tests__/mlServeModes.test.js (the switches themselves), so both suites
// score the same venues, curves and live readings, and a change to one is a
// change to both.
//
// Four venues inside one neighbour box, one far away. Curves are deterministic
// multiples of five; venue 104 has holes and a zero-valued slot beside positive
// neighbours, the edge where blendBaselineRows serves a positive baseline.
//
// The live readings are taken at nine hours a day on three dates, spaced so
// that the most recent earlier reading of a venue is one, two, three, six and
// seven hours old somewhere in the fixture: every lag bucket the nowcast
// weighs (1, 2, 3, 4+) is reached.
//
// makeFixturePool answers the statements predictBusyness sends, from the same
// corpus the replay reads out of a CSV, AS OF the serve moment of each row:
// the trailing offset buildRecentDeviation would have written by then, and the
// recent readings it would have stored AFTER THE TARGET HOUR'S OWN SWEEP, so
// the target hour's reading is in the stored list whenever the venue was read
// then. The nowcast must skip it; the parity test proves it does.
// ---------------------------------------------------------------------------

const fs = require('fs');

const exporter = require('../../scripts/ml/train/export_training_data');

const VENUES = [
  { id: 101, lat: 40.60210, lng: -75.47120, cat: 'bar', types: ['bar', 'restaurant', 'food'] },
  { id: 102, lat: 40.60250, lng: -75.47000, cat: 'restaurant', types: ['restaurant', 'food', 'point_of_interest'] },
  { id: 103, lat: 40.59990, lng: -75.47300, cat: 'cafe', types: ['cafe', 'food', 'store'] },
  { id: 104, lat: 40.60100, lng: -75.47150, cat: 'restaurant', types: ['meal_takeaway', 'restaurant'] },
  { id: 105, lat: 40.75000, lng: -75.30000, cat: 'gym', types: ['gym', 'health'] },
];

const DATES = ['2026-09-04', '2026-09-05', '2026-09-06'];
// In the order a day's readings are taken. 11 -> 13 is two hours, 13 -> 16
// three, 3 -> 9 six and 20 -> 3 (the next morning) seven.
const HOURS = [3, 9, 10, 11, 13, 16, 18, 19, 20];

function curveValue(v, dow, hour) {
  return Math.min(100, 5 * ((dow * 3 + hour * 2 + v.id) % 21));
}

const dayNumber = (dateStr) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
};

function buildFixture() {
  const curves = new Map();
  const weekly = [];
  for (const v of VENUES) {
    const c = new Int16Array(168).fill(-1);
    for (let dow = 0; dow < 7; dow++) {
      for (let hour = 0; hour < 24; hour++) {
        if (v.id === 104 && hour === 3) continue;          // a slot with no row at all
        let val = curveValue(v, dow, hour);
        if (v.id === 104 && hour === 10) val = 0;          // zero, with positive neighbours
        if (v.id === 104 && (hour === 9 || hour === 11)) val = Math.max(val, 40);
        c[dow * 24 + hour] = val;
        weekly.push({ v, dow, hour, val });
      }
    }
    curves.set(String(v.id), c);
  }
  const live = [];
  let k = 0;
  for (const date of DATES) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (const v of VENUES) {
      for (const hour of HOURS) {
        k++;
        const base = curves.get(String(v.id))[dow * 24 + hour];
        const y = Math.max(0, Math.min(100, 5 * Math.round(((base < 0 ? 30 : base) + ((k * 37) % 61) - 30) / 5)));
        live.push({
          v, date, dow, hour, y,
          weather: k % 5 === 0 ? null : { temp: 60 + (k % 25), humidity: 40 + (k % 30), wind: k % 12, code: [800, 801, 803, 500, 701][k % 5], rain: k % 5 === 3 },
        });
      }
    }
  }
  return { curves, weekly, live };
}

function writeFixtureCsv(file, fx) {
  const lines = [exporter.HEADER];
  for (const w of fx.weekly) {
    lines.push(exporter.rowToCsv({
      venue_id: w.v.id, day_of_week: w.dow, hour: w.hour, month: 9, season: 'fall',
      venue_category: w.v.cat, price_level: 2, rating: 4.4, review_count: 900,
      baseline_busyness: w.val, collection_mode: 'weekly', busyness_pct: w.val, city: 'lehigh',
      google_types: w.v.types, latitude: w.v.lat, longitude: w.v.lng,
      avg_user_crowd: 0, user_feedback_count: 0, avg_prediction_error: 0,
      events_observed: false,
    }));
  }
  for (const r of fx.live) {
    const c = fx.curves.get(String(r.v.id))[r.dow * 24 + r.hour];
    lines.push(exporter.rowToCsv({
      venue_id: r.v.id, day_of_week: r.dow, hour: r.hour, month: 9, season: 'fall',
      venue_category: r.v.cat, price_level: 2, rating: 4.4, review_count: 900,
      temperature: r.weather ? r.weather.temp : null, humidity: r.weather ? r.weather.humidity : null,
      wind_speed: r.weather ? r.weather.wind : null, weather_condition: r.weather ? 'clear sky' : null,
      weather_condition_code: r.weather ? r.weather.code : null, is_raining: r.weather ? r.weather.rain : null,
      has_nearby_event: null, events_observed: false,
      baseline_busyness: c < 0 ? 0 : c, collection_mode: 'realtime', busyness_pct: r.y, city: 'lehigh',
      google_types: r.v.types, latitude: r.v.lat, longitude: r.v.lng,
      avg_user_crowd: 0, user_feedback_count: 0, avg_prediction_error: 0,
      stored_observed_date: r.date, label_source: 'live', vendor_forecast_pct: 50,
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// The builder's population, restated naively: a venue's live readings, each
// against its own slot's positive curve (buildRecentDeviation's JOIN ...
// AND b.baseline > 0), with the slot number the nowcast measures lag in.
function builderHistory(fx, venueId) {
  return fx.live
    .filter((r) => r.v.id === venueId)
    .map((r) => ({ r, t: dayNumber(r.date) * 24 + r.hour, b: fx.curves.get(String(venueId))[r.dow * 24 + r.hour] }))
    .filter((x) => x.b > 0);
}

// buildRecentDeviation's UPSERT, restated independently of
// bandEval.makeOffsetLookup: the venue's live readings inside 28 days before
// the moment, newest twenty, each against its own slot's positive curve.
function builderOffset(fx, venueId, date, hour) {
  const t = dayNumber(date) * 24 + hour;
  const devs = builderHistory(fx, venueId)
    .filter((x) => x.t < t && x.t >= t - 28 * 24)
    .sort((a, b) => b.t - a.t)
    .slice(0, 20)
    .map((x) => x.r.y - x.b)
    .sort((a, b) => a - b);
  if (devs.length === 0) return null;
  const n = devs.length;
  return { offset: n % 2 ? devs[(n - 1) / 2] : (devs[n / 2 - 1] + devs[n / 2]) / 2, n };
}

// buildRecentDeviation's recent-readings statement, restated: the venue's
// newest `keep` live readings with a slot at or before (date, hour), newest
// first, in the stored shape. INCLUSIVE of the target hour: this is the table
// after that hour's sweep, which is the state the nowcast must not be fooled
// by.
function builderReadings(fx, venueId, date, hour, keep) {
  const t = dayNumber(date) * 24 + hour;
  return builderHistory(fx, venueId)
    .filter((x) => x.t <= t)
    .sort((a, b) => b.t - a.t)
    .slice(0, keep)
    .map((x) => ({
      v: x.r.y,
      d: x.r.date,
      dow: x.r.dow,
      h: x.r.hour,
      at: `${x.r.date}T${String(x.r.hour).padStart(2, '0')}:20:00.000Z`,
    }));
}

// A pool that answers predictBusyness from the fixture. `moment(alias)` names
// the venue and the serve moment ({ venueId, date, hour }) a place id stands
// for; each row of a parity run gets a fresh alias, because the predictor's
// per-place caches would otherwise hand one moment's answers to the next.
// `unknown` collects any statement the fixture does not answer.
function makeFixturePool(fx, moment, { keepReadings = 3 } = {}) {
  const unknown = [];
  const byAlias = (placeId) => {
    const m = moment(placeId);
    return m ? { m, v: VENUES.find((x) => x.id === m.venueId) } : null;
  };
  const query = async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, ' ');
    if (/FROM ml_venue_baselines WHERE google_place_id = \$1 AND/.test(sql)) {
      const { v } = byAlias(params[0]);
      const c = fx.curves.get(String(v.id));
      const rows = [];
      for (const [d, h] of [[params[1], params[2]], [params[3], params[4]], [params[5], params[6]]]) {
        if (c[d * 24 + h] >= 0) rows.push({ day_of_week: d, hour: h, baseline: String(c[d * 24 + h]), source: 'collected', updated_at: new Date() });
      }
      return { rows };
    }
    if (/v\.latitude BETWEEN/.test(sql) && /GROUP BY b\.day_of_week, b\.hour/.test(sql)) {
      const [lat, lng, box] = params.map(Number);
      const agg = new Map();
      for (const v of VENUES) {
        if (!(v.lat >= lat - box && v.lat <= lat + box && v.lng >= lng - box && v.lng <= lng + box)) continue;
        const c = fx.curves.get(String(v.id));
        for (let s = 0; s < 168; s++) {
          if (c[s] < 0) continue;
          const e = agg.get(s) || { dow: Math.floor(s / 24), hour: s % 24, cnt: 0, sum_bl: 0 };
          e.cnt += 1;
          e.sum_bl += c[s];
          agg.set(s, e);
        }
      }
      return { rows: [...agg.values()].map((e) => ({ ...e, sum_bl: String(e.sum_bl) })) };
    }
    if (/AS lat, v\.longitude AS lng/.test(sql)) {
      const { v } = byAlias(params[0]);
      const c = fx.curves.get(String(v.id));
      const rows = [];
      for (let s = 0; s < 168; s++) if (c[s] >= 0) rows.push({ lat: String(v.lat), lng: String(v.lng), dow: Math.floor(s / 24), hour: s % 24, baseline: String(c[s]) });
      return { rows };
    }
    if (/FROM ml_venue_recent_deviation/.test(sql)) {
      const { m } = byAlias(params[0]);
      const off = builderOffset(fx, m.venueId, m.date, m.hour);
      if (!off) return { rows: [] };
      const row = { offset_pct: off.offset, n_readings: off.n, updated_at: new Date() };
      // Only a statement that asks for the column gets it, the way Postgres
      // answers: a predictor that never selects it never sees it.
      if (/recent_readings/.test(sql)) row.recent_readings = builderReadings(fx, m.venueId, m.date, m.hour, keepReadings);
      return { rows: [row] };
    }
    if (/FROM venue_feedback/.test(sql)) return { rows: [{ avg_crowd: null, count: 0, avg_error_mapped: null, avg_error_legacy: null }] };
    unknown.push(sql.slice(0, 120));
    return { rows: [] };
  };
  return { query, unknown };
}

module.exports = {
  VENUES,
  DATES,
  HOURS,
  curveValue,
  dayNumber,
  buildFixture,
  writeFixtureCsv,
  builderHistory,
  builderOffset,
  builderReadings,
  makeFixturePool,
};
