// ---------------------------------------------------------------------------
// THE CONTEXT FEATURES ARE ONE COMPUTATION: CALENDAR, WEATHER, EVENTS.
//
// The retrain carries the date (day of week, hour, the weekend and
// Friday/Saturday flags, the holidays and special nights), the weather and the
// nearby events. Each family is built twice: by prepare_features.py from the
// columns collectRealtime.js stored with a live reading, and by
// mlPredictor.buildFeatureMap from what serving has at request time (the
// venue's clock, weatherService's reading, getNearbyEvents' answer). The
// pieces had constants pinned here and there; nothing ran both builders over
// the same inputs and compared the values the model is handed.
//
// This does, on a random grid of live rows across every configured city and a
// year of dates chosen to hit special nights, holiday eves, federal holidays
// and school breaks: readings with and without weather (a missing reading
// takes the climate norm on both sides), every weather code group, events
// observed and not, every event type, bars and not. Every column of every
// family must agree after the float32 cast the model sees; a float64
// difference below 1e-9 (numpy's and V8's trigonometry disagreeing in the last
// bit) is counted and reported, never a changed value.
//
// is_holiday and is_school_break are not computed in Python: the collector
// stamps them with config.isHoliday / isSchoolBreak of the reading's local
// date and training reads the column. The grid stamps them the way
// collectRealtime.storeReading does, so this also pins that the stamp is the
// function serving calls.
//
// Skipped, not failed, where Python with pandas is absent. Run: node --test
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-context-parity';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mlPredictor = require('../services/mlPredictor');
const I = mlPredictor._internals;
const { CITIES, isHoliday, isSchoolBreak } = require('../scripts/ml/config');
const HOLIDAYS = require('../scripts/ml/holidays.json');

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');
const PY_PANDAS = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import pandas, numpy'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CODES = [200, 211, 300, 500, 501, 502, 522, 600, 622, 701, 741, 800, 801, 802, 803, 804, 900];
const TYPES = ['music', 'sports', 'arts', 'family', 'other'];
const CATS = ['bar', 'nightclub', 'restaurant', 'cafe', 'gym'];
const SEASON = (m) => (m >= 3 && m <= 5 ? 'spring' : m >= 6 && m <= 8 ? 'summer' : m >= 9 && m <= 11 ? 'fall' : 'winter');

function interestingDates() {
  const out = new Set();
  for (const layer of Object.values(HOLIDAYS.special_nights || {})) {
    for (const d of Object.keys(layer)) if (d.startsWith('2026')) out.add(d);
  }
  for (const list of Object.values(HOLIDAYS.holidays || {})) {
    for (const d of list) {
      if (!d.startsWith('2026')) continue;
      out.add(d);
      const eve = new Date(`${d}T00:00:00Z`);
      eve.setUTCDate(eve.getUTCDate() - 1);
      out.add(eve.toISOString().slice(0, 10));
    }
  }
  for (let m = 0; m < 12; m++) for (const d of [3, 11, 19, 27]) out.add(new Date(Date.UTC(2026, m, d)).toISOString().slice(0, 10));
  return [...out].sort();
}

function buildGrid() {
  const r = rng(20260929);
  const dates = interestingDates();
  const cities = Object.entries(CITIES);
  const rows = [];
  for (let k = 0; k < 1500; k++) {
    const [city, c] = cities[Math.floor(r() * cities.length)];
    const date = dates[Math.floor(r() * dates.length)];
    const hour = Math.floor(r() * 24);
    const d = new Date(`${date}T00:00:00Z`);
    const month = d.getUTCMonth() + 1;
    const lat = Math.round((c.lat + (r() - 0.5) * 0.06) * 1e6) / 1e6;
    const lng = Math.round((c.lon + (r() - 0.5) * 0.06) * 1e6) / 1e6;
    const hasWx = r() > 0.15;
    const observed = r() > 0.3;
    const hasEvent = observed && r() < 0.4;
    rows.push({
      city, observed_date: date, day_of_week: d.getUTCDay(), hour, month, season: SEASON(month),
      latitude: lat, longitude: lng, venue_category: CATS[Math.floor(r() * CATS.length)],
      // Stamped the way collectRealtime.storeReading stamps them.
      is_holiday: isHoliday(date) ? 1 : 0, is_school_break: isSchoolBreak(date) ? 1 : 0,
      temperature: hasWx ? Math.round((20 + r() * 75) * 10) / 10 : null,
      humidity: hasWx ? Math.floor(r() * 100) : null,
      wind_speed: hasWx ? Math.round(r() * 250) / 10 : null,
      is_raining: hasWx ? (r() < 0.2 ? 1 : 0) : null,
      weather_condition_code: hasWx ? CODES[Math.floor(r() * CODES.length)] : null,
      weather_condition: hasWx ? 'x' : null,
      events_observed: observed ? 1 : 0,
      has_nearby_event: observed ? (hasEvent ? 1 : 0) : null,
      nearest_event_attendance: hasEvent ? (r() < 0.5 ? Math.floor(r() * 20000) : null) : (observed ? 0 : null),
      total_nearby_events: observed ? (hasEvent ? 1 + Math.floor(r() * 3) : 0) : null,
      total_nearby_attendance: hasEvent ? Math.floor(r() * 40000) : (observed ? 0 : null),
      nearest_event_distance_km: hasEvent ? Math.round(r() * 2000) / 1000 : null,
      nearest_event_type: hasEvent ? TYPES[Math.floor(r() * TYPES.length)] : null,
    });
  }
  return rows;
}

const COMPARED = [
  // calendar
  'day_of_week', 'hour', 'month', 'hour_sin', 'hour_cos', 'month_sin', 'month_cos', 'dow_sin', 'dow_cos',
  'is_weekend', 'is_friday_saturday_night', 'is_lunch_hour', 'is_dinner_hour', 'is_late_night', 'is_morning',
  'season_spring', 'season_summer', 'season_fall', 'season_winter',
  'is_holiday', 'is_school_break', 'is_special_night', 'special_boost', 'special_suppress', 'is_holiday_eve',
  'daylight_hours', 'hours_after_sunset', 'is_after_sunset',
  // weather
  'temperature', 'humidity', 'wind_speed', 'is_raining',
  'weather_clear', 'weather_few_clouds', 'weather_cloudy', 'weather_light_rain', 'weather_heavy_rain',
  'weather_snow', 'weather_thunderstorm', 'weather_other', 'weather_unknown',
  'rain_x_weekend', 'rain_x_dinner', 'cold_outdoor', 'temp_anomaly', 'is_warm_anomaly_evening',
  // events
  'has_nearby_event', 'nearest_event_attendance', 'log_nearest_event_attendance', 'nearest_event_distance_km',
  'total_nearby_events', 'total_nearby_attendance', 'log_total_nearby_attendance', 'large_event_nearby',
  'event_x_weekend', 'event_x_dinner', 'event_x_bar',
  'etype_music', 'etype_sports', 'etype_arts', 'etype_family', 'etype_other',
];

const DRIVER = `
import sys, json
import numpy as np, pandas as pd
sys.path.insert(0, sys.argv[1])
import prepare_features as pf
cols = json.loads(sys.argv[3])
df = pd.DataFrame(json.load(open(sys.argv[2])))
df = pf.add_temporal_features(df)
norms = pf.fit_temperature_norms(df)
df = pf.add_weather_features(df, norms)
df = pf.add_event_features(df)
df = pf.add_astronomy_features(df)
df, _ = pf.add_climate_anomaly(df, norms)
df = pf.add_holiday_features(df)
out = {c: [float(x) for x in pd.to_numeric(df[c])] for c in cols}
out.update({c + '_f32': [float(x) for x in pd.to_numeric(df[c]).to_numpy().astype(np.float32)] for c in cols})
out['temp_norms'] = {f"{int(r.lat_band)}_{int(r.month)}": round(float(r.temp_norm), 2) for r in norms.itertuples()}
print('RESULT ' + json.dumps(out))
`;

test('the calendar, weather and event families agree between training and serving on every row', { skip: PY_PANDAS ? false : 'python with pandas not available' }, async (t) => {
  const rows = buildGrid();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-context-'));
  const data = path.join(dir, 'rows.json');
  const driver = path.join(dir, 'drive.py');
  fs.writeFileSync(data, JSON.stringify(rows));
  fs.writeFileSync(driver, DRIVER);
  let r;
  try {
    r = spawnSync(PY_PANDAS, [driver, TRAIN_DIR, data, JSON.stringify(COMPARED)], { encoding: 'utf8', maxBuffer: 1 << 27 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(r.status, 0, r.stderr);
  const py = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));

  const log = console.log;
  console.log = () => {};
  try { assert.equal(await mlPredictor.init(), true); } finally { console.log = log; }
  const meta = I.getMetadata();
  const savedNorms = meta.temp_norms;
  // The artifact a retrain on these rows would ship: its own climate table.
  meta.temp_norms = py.temp_norms;
  let js;
  try {
    js = rows.map((row) => {
      const ts = new Date(`${row.observed_date}T${String(row.hour).padStart(2, '0')}:30:00Z`);
      const weather = row.temperature === null ? null : {
        temp: row.temperature, humidity: row.humidity, windSpeed: row.wind_speed,
        isRaining: row.is_raining === 1, conditionId: row.weather_condition_code, conditions: 'x',
      };
      const events = row.events_observed ? {
        observed: true, hasEvent: row.has_nearby_event === 1,
        nearestAttendance: row.nearest_event_attendance || 0, totalEvents: row.total_nearby_events || 0,
        totalAttendance: row.total_nearby_attendance || 0, nearestDistance: row.nearest_event_distance_km || 0,
        nearestType: row.nearest_event_type,
      } : { observed: false, unavailableReason: 'not_recorded' };
      const venue = { venue_category: row.venue_category, types: [], location: { latitude: row.latitude, longitude: row.longitude } };
      return I.buildFeatureMap(venue, weather, ts, events, null, 50, null);
    });
  } finally {
    meta.temp_norms = savedNorms;
  }

  // The grid reaches what decides each family.
  const count = (c, test) => rows.filter((_, i) => test(js[i][c])).length;
  assert.ok(count('is_special_night', (v) => v === 1) > 20, 'special nights');
  assert.ok(count('is_holiday_eve', (v) => v === 1) > 20, 'holiday eves');
  assert.ok(count('is_holiday', (v) => v === 1) > 5, 'federal holidays');
  assert.ok(count('special_suppress', (v) => v > 0) > 0 && count('special_boost', (v) => v > 0) > 0, 'both effects');
  assert.ok(count('weather_unknown', (v) => v === 1) > 50, 'missing readings');
  assert.ok(count('cold_outdoor', (v) => v === 1) > 0, 'cold and clear');
  assert.ok(count('is_warm_anomaly_evening', (v) => v === 1) > 0, 'warm evenings');
  for (const e of ['etype_music', 'etype_sports', 'etype_arts', 'etype_family', 'etype_other', 'event_x_bar', 'large_event_nearby']) {
    assert.ok(count(e, (v) => v === 1) > 0, e);
  }

  const diff = [];
  const f32 = [];
  let lastBit = 0;
  rows.forEach((row, i) => {
    for (const c of COMPARED) {
      const a = py[c][i];
      const b = Number(js[i][c]);
      if (a !== b) {
        if (Math.abs(a - b) < 1e-9) lastBit++;
        else diff.push({ i, c, python: a, serving: b, city: row.city, date: row.observed_date, hour: row.hour });
      }
      if (py[`${c}_f32`][i] !== Math.fround(b)) f32.push({ i, c, python: py[`${c}_f32`][i], serving: Math.fround(b) });
    }
  });
  t.diagnostic(`${rows.length} rows x ${COMPARED.length} columns: ${diff.length} disagreements, `
    + `${f32.length} after float32, ${lastBit} last-bit float64 differences`);
  assert.deepEqual(diff.slice(0, 10), [], `${diff.length} values disagree`);
  assert.deepEqual(f32.slice(0, 10), [], `${f32.length} values disagree after the float32 cast`);
});
