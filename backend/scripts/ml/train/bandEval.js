'use strict';
// ---------------------------------------------------------------------------
// BAND EVALUATION: WHAT THE CARD SHOWS, SCORED AGAINST THE LIVE READINGS.
//
// The number the product is judged on is the one on the admin Overview "Model"
// card (services/moneyHub.js readServedBandAccuracy): the share of served
// forecasts that land within one crowd band (Quiet / Not Busy / Steady / Busy /
// Packed, crowdEngine.getLabel) of the live reading the collector took for the
// same venue and hour. Every offline number before this file scored something
// else: a float reconstruction without the quantile map or the per-venue
// offset, on point metrics, on a population of rows collected before anybody
// could tell a live reading from a vendor forecast.
//
// This file REPLAYS THE SERVE PATH over exported live readings, through the
// production functions themselves, not a Python restatement of them:
//
//   baseline    mlPredictor.blendBaselineRows over the venue's weekly curve
//               (the ml_venue_baselines rows buildBaselines.js writes, read off
//               the export's baseline_busyness column, which is that statement
//               verbatim; __tests__/mlExportContracts.test.js pins it)
//   neighbours  getNeighborActivity's box arithmetic over the same curves
//   vector      mlPredictor._internals.buildFeatureVector, with the loaded
//               artifact's own metadata, exactly as predictBusyness builds it
//   score       reconstructScore, then the score quantile map under the same
//               flag and version check, then half the venue's trailing live
//               offset (buildRecentDeviation.js, past-only), then the band
//   fallback    crowdEngine.calculateCrowdScore wherever production would
//               answer from the rule engine (no usable baseline)
//
// and scores, on the SAME rows, the model as served against things it has to
// beat to mean anything: the rule engine, the venue's weekly curve at that
// local hour (the naive baseline) and the curve plus the trailing offset. Two
// references ride along, never served: the venue's last live reading carried
// forward, and the best constant band (what hedging alone scores).
//
// WHICH ROWS. Only `label_source = 'live'` realtime rows: the one provenance
// that proves it is an observation of a room rather than BestTime's own
// forecast replayed back (migration 025). Never weekly anchors, whose label
// equals the baseline by construction. The window is a TIME-BASED holdout:
// rows observed on or after `--from`, which a candidate's metadata declares in
// time_holdout.from_date (prepare_features.py cuts those rows out of training).
//
// WHAT IT CANNOT REPLAY, stated so nobody mistakes the replay for the card:
//   * the venue record. Production scores the Google Places payload of the
//     moment (types, rating, review count, price) and leaves the category to
//     guessCategory(types); the replay uses the corpus's copy of those fields
//     and, by default, the same guessCategory path.
//   * the weather and event lookups of the moment. The replay uses what the
//     collector recorded at the reading: the same OpenWeatherMap and
//     Ticketmaster sources asked about the same hour, though the collector
//     reads the city centre's weather where the card reads the venue's.
//   * which venues users open. The card's figure counts only venue-hours
//     somebody was served; this counts every live reading.
//
// IT NEVER OPENS A DATABASE CONNECTION. It reads CSV exports. Before any
// service module loads, DATABASE_URL is pointed at an address nothing listens
// on and every PG* variable is removed, so a stray query fails locally instead
// of reaching a real server. See isolateFromDatabases.
//
// Run (from backend/):
//   node scripts/ml/train/bandEval.js --train=scripts/ml/train/training_data.csv \
//        --holdout=scripts/ml/train/holdout_data.csv --model=scripts/ml/models
//   ... --gate    after export_model.py: writes ship_gate.band_gate into the
//                 candidate's model_metadata.json and sets overall_pass
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BACKEND_DIR = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_MODELS_DIR = path.resolve(__dirname, '..', 'models');
const PREDICTOR_PATH = path.join(BACKEND_DIR, 'services', 'mlPredictor.js');
const CROWD_ENGINE_PATH = path.join(BACKEND_DIR, 'services', 'crowdEngine.js');

// The only database this script may name: an address nothing listens on.
const OFFLINE_DATABASE_URL = 'postgresql://bandeval-offline@127.0.0.1:1/bandeval_offline';
const PG_ENV_KEYS = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'PGSERVICE'];

// buildRecentDeviation.js's window and depth. Restated here rather than
// required because requiring that module opens config/database at load; the
// test pins these two numbers against its source.
const OFFSET_WINDOW_HOURS = 28 * 24;
const OFFSET_MAX_READINGS = 20;

// The collector's holdout cities (export_training_data.js HOLDOUT_CITIES),
// used only to pick the legacy reference slice.
const LEGACY_REFERENCE_CITIES = ['miami', 'tokyo', 'barcelona'];

// A candidate must clear every one of these on the time holdout. They are the
// band gate; RETRAIN.md, "The ship gate" under the mid-October plan, sets them
// out with the measurements behind them.
const BAND_GATE = Object.freeze({
  minRows: 1000,            // model-served live rows in the window
  minDates: 5,              // distinct observation dates (the bootstrap blocks)
  incumbentCiLowerMin: -1.0, // pp: beat the incumbent, and a 95% CI that rules out losing a point
  naiveCiLowerMin: 0.0,     // pp: beat the weekly curve, with a CI that excludes zero
  cityMinRows: 300,         // a city this large must not regress...
  cityMaxRegression: -2.0,  // ...by more than two points against the incumbent
  maeSlack: 1.0,            // point error may not grow by more than a point vs the incumbent
  bootstrapResamples: 2000,
});

// Columns the replay reads. The export writes 45; a CSV missing any of these is
// refused by name rather than scored on shifted fields.
const REQUIRED_COLUMNS = [
  'venue_id', 'day_of_week', 'hour', 'venue_category', 'price_level', 'rating', 'review_count',
  'temperature', 'humidity', 'wind_speed', 'weather_condition', 'weather_condition_code', 'is_raining',
  'has_nearby_event', 'nearest_event_distance_km', 'nearest_event_attendance',
  'total_nearby_events', 'total_nearby_attendance', 'nearest_event_type',
  'baseline_busyness', 'is_realtime', 'busyness_pct', 'city',
  'google_type_1', 'google_type_2', 'google_type_3', 'latitude', 'longitude',
  'observed_date', 'label_source', 'vendor_forecast_pct', 'events_observed',
];

// prepare_features.LEGACY_EVENT_TYPE_ALIASES: what eventService.js wrote
// before 2026-09-04, read through the fixed function.
const LEGACY_EVENT_TYPE_ALIASES = { concert: 'music', film: 'other' };

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

function isolateFromDatabases(env = process.env) {
  for (const k of PG_ENV_KEYS) delete env[k];
  env.DATABASE_URL = OFFLINE_DATABASE_URL;
  env.PGSSLMODE = 'disable';
}

// buildFeatureMap reads the venue's wall clock off the Date's LOCAL getters,
// the way the server (which runs in UTC) does. Pinning this process to UTC
// makes a replayed 02:30 on a daylight-saving night read as 02:30 rather than
// whatever the host zone would turn it into.
function pinUtcClock() {
  process.env.TZ = 'UTC';
  const probe = new Date(2026, 2, 8, 2, 30);
  if (probe.getHours() !== 2 || probe.getTimezoneOffset() !== 0) {
    throw new Error('bandEval: could not pin the process clock to UTC; run it with TZ=UTC.');
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// RFC 4180 fields on one line, the shape export_training_data.js escapeCsv
// writes (quotes only around a field holding a comma, quote or newline).
function parseCsvLine(line) {
  if (line.indexOf('"') === -1) return line.split(',');
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const numOrNull = (s) => {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const flag = (s) => (s === '1' || s === 'true' || s === 't' ? true : s === '0' || s === 'false' || s === 'f' ? false : null);

// Days since the epoch for a 'YYYY-MM-DD' observation date, or null.
function dayNumber(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

// The replay's clock: the reading's venue-local wall time as a Date whose
// local getters return it (the process runs in UTC, see pinUtcClock).
function wallClock(dateStr, hour) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, 30));
}

function realtimeRow(f, ix) {
  const temp = numOrNull(f[ix.temperature]);
  const eventsObserved = flag(f[ix.events_observed]) === true;
  const rawType = String(f[ix.nearest_event_type] || '').trim().toLowerCase();
  const nearestType = rawType ? (LEGACY_EVENT_TYPE_ALIASES[rawType] || rawType) : null;
  return {
    venueId: f[ix.venue_id],
    city: f[ix.city],
    date: f[ix.observed_date],
    dow: Number(f[ix.day_of_week]),
    hour: Number(f[ix.hour]),
    y: Number(f[ix.busyness_pct]),
    labelSource: f[ix.label_source] || '',
    vendorForecast: numOrNull(f[ix.vendor_forecast_pct]),
    venueCategory: f[ix.venue_category] || null,
    types: [f[ix.google_type_1], f[ix.google_type_2], f[ix.google_type_3]].filter(Boolean),
    priceLevel: numOrNull(f[ix.price_level]),
    rating: numOrNull(f[ix.rating]),
    reviewCount: numOrNull(f[ix.review_count]),
    lat: numOrNull(f[ix.latitude]),
    lng: numOrNull(f[ix.longitude]),
    // weatherService's own shape, as the collector stored it for this hour.
    weather: temp === null ? null : {
      temp,
      humidity: numOrNull(f[ix.humidity]),
      windSpeed: numOrNull(f[ix.wind_speed]),
      conditions: f[ix.weather_condition] || null,
      conditionId: numOrNull(f[ix.weather_condition_code]),
      isRaining: flag(f[ix.is_raining]) === true,
    },
    // getNearbyEvents' shape. A row whose lookup was not a measurement is
    // replayed as an unobserved answer, which buildFeatureMap zeroes exactly as
    // it does for a live outage.
    events: eventsObserved ? {
      observed: true,
      hasEvent: flag(f[ix.has_nearby_event]) === true,
      nearestAttendance: numOrNull(f[ix.nearest_event_attendance]) || 0,
      totalEvents: numOrNull(f[ix.total_nearby_events]) || 0,
      totalAttendance: numOrNull(f[ix.total_nearby_attendance]) || 0,
      nearestDistance: numOrNull(f[ix.nearest_event_distance_km]) || 0,
      nearestType,
    } : { observed: false, unavailableReason: 'not_recorded' },
  };
}

// Streams one or more exports. Weekly rows are reduced to the venue curves
// (168 slots, -1 = no ml_venue_baselines row); realtime rows are kept whole
// when they are live, or when they are unknown-provenance rows in a legacy
// reference city and the caller asked for them.
async function readCorpus(files, { legacyCities = [] } = {}) {
  const venues = new Map();
  const curves = new Map();
  const live = [];
  const legacy = [];
  const census = { files: [], rows: 0, weekly: 0, realtime: 0, bySource: {} };
  const legacySet = new Set(legacyCities);

  for (const file of files) {
    const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let ix = null;
    let n = 0;
    for await (const line of lines) {
      if (ix === null) {
        const header = parseCsvLine(line.replace(/^\uFEFF/, ''));
        ix = {};
        header.forEach((name, i) => { ix[name] = i; });
        const missing = REQUIRED_COLUMNS.filter((c) => ix[c] === undefined);
        if (missing.length) {
          throw new Error(`${file} is missing ${missing.length} column(s) the replay reads: ${missing.join(', ')}. `
            + 'Re-run export_training_data.js; a stale export is never only missing the columns you noticed.');
        }
        continue;
      }
      if (!line) continue;
      const f = parseCsvLine(line);
      n++;
      const vid = f[ix.venue_id];
      if (!venues.has(vid)) {
        venues.set(vid, {
          id: vid,
          city: f[ix.city],
          lat: numOrNull(f[ix.latitude]),
          lng: numOrNull(f[ix.longitude]),
        });
      }
      const dow = Number(f[ix.day_of_week]);
      const hour = Number(f[ix.hour]);
      if (f[ix.is_realtime] !== '1') {
        census.weekly++;
        const b = numOrNull(f[ix.baseline_busyness]);
        if (b === null || !(dow >= 0 && dow <= 6 && hour >= 0 && hour <= 23)) continue;
        let curve = curves.get(vid);
        if (!curve) { curve = new Int16Array(168).fill(-1); curves.set(vid, curve); }
        curve[dow * 24 + hour] = Math.round(b);
        continue;
      }
      census.realtime++;
      const src = f[ix.label_source] || '';
      census.bySource[src || 'unknown'] = (census.bySource[src || 'unknown'] || 0) + 1;
      if (src === 'live') live.push(realtimeRow(f, ix));
      else if (src === '' && legacySet.has(f[ix.city])) legacy.push(realtimeRow(f, ix));
    }
    census.files.push({ file: path.basename(file), rows: n });
    census.rows += n;
  }
  return { venues, curves, live, legacy, census };
}

// ---------------------------------------------------------------------------
// The serve-path inputs that do not depend on the model
// ---------------------------------------------------------------------------

// The rows getBaseline's query would return for one slot: the slot itself and
// its clock neighbours, each only when ml_venue_baselines holds it.
function baselineRowsFor(curve, dow, hour, neighborSlots) {
  if (!curve) return [];
  const { prevHour, nextHour, prevDay, nextDay } = neighborSlots(dow, hour);
  const rows = [];
  const add = (d, h) => {
    const v = curve[d * 24 + h];
    if (v >= 0) rows.push({ day_of_week: d, hour: h, baseline: String(v), source: 'collected', updated_at: null });
  };
  add(dow, hour);
  add(prevDay, prevHour);
  add(nextDay, nextHour);
  return rows;
}

// getNeighborActivity over the export's curves: the bounding box on the
// venue's coordinates rounded to 3 places, +/- NEIGHBOR_BOX_DEG, every venue
// with a baseline row for the slot, the venue itself taken back out.
function makeNeighborIndex(venues, curves, boxDeg) {
  const CELL = 0.01;
  const grid = new Map();
  for (const [vid, v] of venues) {
    if (!curves.has(vid) || !Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue;
    const key = `${Math.floor(v.lat / CELL)}_${Math.floor(v.lng / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(v);
  }
  const boxes = new Map();
  function boxFor(bLat, bLng) {
    const key = `${bLat}_${bLng}`;
    if (boxes.has(key)) return boxes.get(key);
    const lat = Number(bLat);
    const lng = Number(bLng);
    const cnt = new Int32Array(168);
    const sum = new Float64Array(168);
    const members = [];
    for (let gx = Math.floor((lat - boxDeg) / CELL); gx <= Math.floor((lat + boxDeg) / CELL); gx++) {
      for (let gy = Math.floor((lng - boxDeg) / CELL); gy <= Math.floor((lng + boxDeg) / CELL); gy++) {
        for (const v of grid.get(`${gx}_${gy}`) || []) {
          // The SQL's BETWEEN, in the same double arithmetic.
          if (v.lat >= lat - boxDeg && v.lat <= lat + boxDeg && v.lng >= lng - boxDeg && v.lng <= lng + boxDeg) {
            members.push(v.id);
            const c = curves.get(v.id);
            for (let s = 0; s < 168; s++) if (c[s] >= 0) { cnt[s]++; sum[s] += c[s]; }
          }
        }
      }
    }
    const entry = { cnt, sum, members };
    boxes.set(key, entry);
    return entry;
  }
  return function neighborActivity(venue, dow, hour) {
    const none = { count: 0, mean: 0 };
    if (!Number.isFinite(venue.lat) || !Number.isFinite(venue.lng)) return none;
    const bLat = (+venue.lat).toFixed(3);
    const bLng = (+venue.lng).toFixed(3);
    const box = boxFor(bLat, bLng);
    const s = dow * 24 + hour;
    if (box.cnt[s] <= 0) return none;
    const own = curves.get(venue.id);
    const inBox = !!own
      && Math.abs(venue.lat - Number(bLat)) <= boxDeg
      && Math.abs(venue.lng - Number(bLng)) <= boxDeg;
    const ownValue = inBox && own[s] >= 0 ? own[s] : undefined;
    const count = Math.max(0, box.cnt[s] - (ownValue === undefined ? 0 : 1));
    if (count === 0) return none;
    return { count, mean: Math.max(0, Math.min(100, (box.sum[s] - (ownValue || 0)) / count)) };
  };
}

// percentile_cont(0.5): the middle value, or the mean of the two middle values.
function median(values) {
  const a = values.slice().sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// buildRecentDeviation.js, replayed past-only: for a reading at hour t, the
// median of (live - that slot's curve) over the venue's most recent live
// readings strictly before t, inside the 28-day window, at most 20 of them,
// counted only where the curve holds a positive baseline for the reading's own
// slot (the builder's JOIN ... AND b.baseline > 0). The serving path refuses
// fewer than DEVIATION_MIN_READINGS and clamps to +/-DEVIATION_CLAMP.
function makeOffsetLookup(liveRows, curves, { minReadings, clamp }) {
  const byVenue = new Map();
  for (const r of liveRows) {
    const curve = curves.get(r.venueId);
    const day = dayNumber(r.date);
    if (!curve || day === null) continue;
    const b = curve[r.dow * 24 + r.hour];
    if (!(b > 0)) continue;
    if (!byVenue.has(r.venueId)) byVenue.set(r.venueId, []);
    byVenue.get(r.venueId).push({ t: day * 24 + r.hour, dev: r.y - b });
  }
  for (const list of byVenue.values()) list.sort((a, b) => a.t - b.t);
  const offsetAt = function offsetAt(venueId, t) {
    const list = byVenue.get(venueId);
    if (!list) return { offset: null, readings: 0, prior: 0 };
    // First index with list[i].t >= t: everything before it is strictly earlier.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t < t) lo = mid + 1; else hi = mid; }
    const prior = lo;
    const window = [];
    for (let i = lo - 1; i >= 0 && window.length < OFFSET_MAX_READINGS; i--) {
      if (list[i].t < t - OFFSET_WINDOW_HOURS) break;
      window.push(list[i].dev);
    }
    if (window.length < minReadings) return { offset: null, readings: window.length, prior };
    const raw = median(window);
    return { offset: Math.max(-clamp, Math.min(clamp, raw)), readings: window.length, prior };
  };
  // THE NOWCAST REFERENCE: the venue's most recent live reading strictly before
  // t, if it is at most NOWCAST_MAX_AGE_HOURS old, as a deviation from its own
  // slot's curve. Not served anywhere today; reported so every run shows what
  // carrying the last reading forward would buy (RETRAIN.md, the October plan).
  offsetAt.lastReading = function lastReading(venueId, t) {
    const list = byVenue.get(venueId);
    if (!list) return null;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t < t) lo = mid + 1; else hi = mid; }
    if (lo === 0) return null;
    const last = list[lo - 1];
    const age = t - last.t;
    return age <= NOWCAST_MAX_AGE_HOURS ? { dev: last.dev, ageHours: age } : null;
  };
  return offsetAt;
}

// How the nowcast reference weighs a reading by its age, measured on the
// 2026-09-01..08 live rows (deviation autocorrelation 0.815 at one hour, 0.487
// at two, 0.203 at three): full weight at one hour, three quarters at two,
// nothing older.
const NOWCAST_MAX_AGE_HOURS = 2;
const NOWCAST_WEIGHT_BY_AGE = { 1: 1.0, 2: 0.75 };

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

// A fresh mlPredictor for one artifact directory. mlPredictor reads its two
// files from a fixed path, so for the length of init() the fs and onnxruntime
// calls that name those two paths are pointed at `dir`, and put back after.
// The metadata it is shown has overall_pass forced true, because the thing
// being decided here is whether the artifact should pass; every other load
// check (the quantile-map version refusal, the feature-coverage check, the
// graph/metadata shape check) runs as production runs it and still refuses.
async function loadArtifact(dir) {
  isolateFromDatabases();
  const absDir = path.resolve(dir);
  const onnxPath = path.join(absDir, 'crowd_model.onnx');
  const metaPath = path.join(absDir, 'model_metadata.json');
  if (!fs.existsSync(onnxPath) || !fs.existsSync(metaPath)) {
    throw new Error(`${absDir} does not hold crowd_model.onnx and model_metadata.json.`);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (meta.label_type === 'two_head') {
    throw new Error(`${absDir} is a two-head artifact; the band replay scores single-graph delta models only.`);
  }
  const presented = JSON.stringify({
    ...meta,
    ship_gate: { ...(meta.ship_gate || {}), overall_pass: true },
  });

  const servedOnnx = path.join(DEFAULT_MODELS_DIR, 'crowd_model.onnx');
  const servedMeta = path.join(DEFAULT_MODELS_DIR, 'model_metadata.json');
  const ort = require('onnxruntime-node');
  const originals = {
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    create: ort.InferenceSession.create,
  };
  const isPath = (p, target) => typeof p === 'string' && path.resolve(p) === target;
  fs.existsSync = function patchedExists(p, ...rest) {
    if (isPath(p, servedOnnx)) return originals.existsSync.call(fs, onnxPath);
    if (isPath(p, servedMeta)) return originals.existsSync.call(fs, metaPath);
    return originals.existsSync.call(fs, p, ...rest);
  };
  fs.readFileSync = function patchedRead(p, ...rest) {
    if (isPath(p, servedMeta)) return typeof rest[0] === 'string' || (rest[0] && rest[0].encoding) ? presented : Buffer.from(presented);
    return originals.readFileSync.call(fs, p, ...rest);
  };
  ort.InferenceSession.create = function patchedCreate(p, ...rest) {
    return originals.create.call(ort.InferenceSession, isPath(p, servedOnnx) ? onnxPath : p, ...rest);
  };

  delete require.cache[PREDICTOR_PATH];
  let predictor;
  let loaded;
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  const quiet = [];
  console.log = (...a) => quiet.push(a.join(' '));
  console.warn = console.log;
  console.error = console.log;
  try {
    predictor = require(PREDICTOR_PATH);
    loaded = await predictor.init();
  } finally {
    fs.existsSync = originals.existsSync;
    fs.readFileSync = originals.readFileSync;
    ort.InferenceSession.create = originals.create;
    console.log = log;
    console.warn = warn;
    console.error = error;
    delete require.cache[PREDICTOR_PATH];
  }
  if (!loaded) {
    throw new Error(`the serving path refused ${absDir}: ${quiet.filter((l) => /REFUS|Failed|threw/.test(l)).join(' | ') || quiet.join(' | ')}`);
  }
  const I = predictor._internals;
  const m = I.getMetadata();
  if (!m || m.model_version !== meta.model_version || m.feature_count !== meta.feature_count) {
    throw new Error(`loaded the wrong artifact: expected ${meta.model_version}, got ${m && m.model_version}.`);
  }
  return { dir: absDir, meta: m, predictor, I, session: I.getSession() };
}

// Runs the graph over many vectors at once when it accepts a batch, one at a
// time when it does not.
async function runGraph(art, vectors) {
  const ort = require('onnxruntime-node');
  const inputName = art.meta.onnx_input_name || 'input';
  const width = art.meta.feature_names.length;
  const out = new Float64Array(vectors.length);
  const CHUNK = 4096;
  for (let start = 0; start < vectors.length; start += CHUNK) {
    const part = vectors.slice(start, start + CHUNK);
    const flat = new Float32Array(part.length * width);
    part.forEach((v, i) => flat.set(v, i * width));
    try {
      const res = await art.session.run({ [inputName]: new ort.Tensor('float32', flat, [part.length, width]) });
      const data = res[art.session.outputNames[0]].data;
      for (let i = 0; i < part.length; i++) out[start + i] = Number(data[i]);
    } catch (_) {
      for (let i = 0; i < part.length; i++) {
        const res = await art.session.run({ [inputName]: new ort.Tensor('float32', part[i], [1, width]) });
        out[start + i] = Number(res[art.session.outputNames[0]].data[0]);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

// Everything about a row that no model changes: the served baseline, the
// neighbours, the trailing offset, the curve, the rule engine's answer.
function prepareRows(rows, corpus, helpers, { category = 'guess' } = {}) {
  const { I, crowdEngine } = helpers;
  const neighborActivity = makeNeighborIndex(corpus.venues, corpus.curves, I.NEIGHBOR_BOX_DEG);
  const offsetAt = makeOffsetLookup(corpus.live, corpus.curves, {
    minReadings: I.DEVIATION_MIN_READINGS, clamp: I.DEVIATION_CLAMP,
  });
  const out = [];
  out.skipped = 0;
  for (const r of rows) {
    const day = dayNumber(r.date);
    if (day === null || !(r.hour >= 0 && r.hour <= 23) || !Number.isFinite(r.y)) { out.skipped++; continue; }
    const ts = wallClock(r.date, r.hour);
    // A date and a weekday that disagree cannot both be the reading's clock
    // (the pre-September collector stamped the weekday once per city block and
    // the exporter dates the row from collected_at). Counted, not scored.
    if (ts.getDay() !== r.dow) { out.skipped++; continue; }
    const curve = corpus.curves.get(r.venueId);
    const rows3 = baselineRowsFor(curve, r.dow, r.hour, I.baselineNeighborSlots);
    const smoothed = I.blendBaselineRows(rows3, r.dow, r.hour).data;
    const rawCurve = curve && curve[r.dow * 24 + r.hour] >= 0 ? curve[r.dow * 24 + r.hour] : null;
    const venue = {
      place_id: `bandeval-${r.venueId}`,
      types: r.types,
      rating: r.rating || null,
      user_ratings_total: r.reviewCount || 0,
      price_level: r.priceLevel,
      location: Number.isFinite(r.lat) && Number.isFinite(r.lng) ? { latitude: r.lat, longitude: r.lng } : null,
    };
    if (category === 'corpus' && r.venueCategory) venue.venue_category = r.venueCategory;
    const neighbors = neighborActivity({ id: r.venueId, lat: r.lat, lng: r.lng }, r.dow, r.hour);
    const off = offsetAt(r.venueId, day * 24 + r.hour);
    const last = offsetAt.lastReading(r.venueId, day * 24 + r.hour);
    const rule = crowdEngine.calculateCrowdScore(venue, r.weather, ts).score;
    out.push({
      ...r,
      ts,
      venue,
      neighbors,
      smoothed,
      rawCurve,
      offset: off.offset,
      offsetReadings: off.readings,
      priorLive: off.prior,
      nowcast: last && rawCurve !== null
        ? Math.max(0, Math.min(100, Math.round(rawCurve + NOWCAST_WEIGHT_BY_AGE[last.ageHours] * last.dev)))
        : null,
      nowcastAgeHours: last ? last.ageHours : null,
      guessedCategory: I.guessCategory(r.types),
      rule,
    });
  }
  return out;
}

// One artifact over prepared rows: the served score and its parts.
async function scoreArtifact(art, prepared, { qmap } = {}) {
  const { I } = art;
  const qmapOn = qmap === undefined ? I.qmapEnabled() : Boolean(qmap);
  const mlIdx = [];
  const vectors = [];
  prepared.forEach((r, i) => {
    if (!(r.smoothed > 0)) return; // predictBusyness: no baseline -> rule engine
    if (!I.hasTempReading(r.weather)
        && (art.meta.feature_names || []).includes('temperature')
        && I.tempForFeature(r.weather, r.lat, r.ts.getMonth() + 1) == null) return;
    mlIdx.push(i);
    vectors.push(I.buildFeatureVector(r.venue, r.weather, r.ts, r.events, null, r.smoothed, r.neighbors));
  });
  const raw = await runGraph(art, vectors);
  const mapsThisModel = (art.meta.model_version || '') === I.QMAP_FITTED_ON;
  const res = prepared.map((r) => ({ ml: false, served: r.rule }));
  mlIdx.forEach((i, k) => {
    const r = prepared[i];
    const rawDelta = raw[k];
    if (!Number.isFinite(rawDelta)) return; // the catch in predictBusyness answers from the rule engine
    const base = art.meta.label_type === 'delta'
      ? I.reconstructScore(rawDelta, r.smoothed)
      : Math.max(0, Math.min(100, Math.round(rawDelta)));
    const mapped = qmapOn && mapsThisModel ? I.applyScoreQuantileMap(base) : base;
    const withOffset = (s) => (r.offset === null ? s
      : Math.max(0, Math.min(100, Math.round(s + I.DEVIATION_WEIGHT * r.offset))));
    res[i] = {
      ml: true,
      rawDelta,
      reconstructed: base,
      mapped: mapsThisModel ? I.applyScoreQuantileMap(base) : base,
      withOffset: withOffset(base),
      served: withOffset(mapped),
    };
  });
  return {
    version: art.meta.model_version,
    qmapApplied: qmapOn && mapsThisModel,
    rows: res,
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

// The ladder, read off crowdEngine.getLabel exactly as moneyHub.crowdBandLadder
// reads it: a cut is the last score of a band.
function bandLadder(getLabel) {
  const cuts = [];
  const labels = [];
  for (let s = 0; s < 100; s++) {
    if (getLabel(s) !== getLabel(s + 1)) { cuts.push(s); labels.push(getLabel(s)); }
  }
  labels.push(getLabel(100));
  return { cuts, labels };
}

// A score's band is how many cuts it exceeds (moneyHub's SQL, band_of in
// eval_two_head.py).
function bandOf(score, cuts) {
  let b = 0;
  for (const c of cuts) if (score > c) b++;
  return b;
}

function summarize(actual, pred, cuts) {
  const n = actual.length;
  const k = cuts.length + 1;
  const confusion = Array.from({ length: k }, () => new Array(k).fill(0));
  let exact = 0;
  let within1 = 0;
  let absErr = 0;
  let signed = 0;
  let within10 = 0;
  let within15 = 0;
  let bandAbs = 0;
  for (let i = 0; i < n; i++) {
    const a = bandOf(actual[i], cuts);
    const p = bandOf(pred[i], cuts);
    confusion[a][p]++;
    const d = Math.abs(a - p);
    if (d === 0) exact++;
    if (d <= 1) within1++;
    bandAbs += d;
    const e = pred[i] - actual[i];
    absErr += Math.abs(e);
    signed += e;
    if (Math.abs(e) <= 10) within10++;
    if (Math.abs(e) <= 15) within15++;
  }
  const pct = (x) => (n ? Math.round((x / n) * 1000) / 10 : null);
  const r2 = (x) => (n ? Math.round((x / n) * 100) / 100 : null);
  return {
    n,
    within_one_band: pct(within1),
    band_exact: pct(exact),
    // Mean distance in bands. The hedge-resistant companion to
    // within_one_band: a constant "Not Busy" is within one band of Quiet, Not
    // Busy and Steady alike, so it scores high on within_one_band, but it is
    // three bands off every Packed room and pays for each of them here.
    band_mae: n ? Math.round((bandAbs / n) * 1000) / 1000 : null,
    mae: r2(absErr),
    bias: r2(signed),
    within_10: pct(within10),
    // The figure mlPredictor publishes as the card's confidence.
    within_15: pct(within15),
    predicted_band_share: confusion[0].map((_, p) => pct(confusion.reduce((s, row) => s + row[p], 0))),
    actual_band_share: confusion.map((row) => pct(row.reduce((s, x) => s + x, 0))),
    confusion,
  };
}

// WHAT A CONSTANT ANSWER SCORES. On a bimodal target within_one_band rewards
// hedging: the band next to the commonest one covers three of the five bands.
// On the 2026-09-01..08 live rows a constant "Not Busy" is within one band
// 75.8% of the time, above every configuration the product has served. So
// every report carries the best constant, chosen IN-SAMPLE (which flatters it),
// and nobody reads a within_one_band figure without it.
function bestConstantBand(actual, cuts, labels) {
  const mids = [];
  const edges = [-1, ...cuts, 100];
  for (let b = 0; b < edges.length - 1; b++) mids.push(Math.round((edges[b] + 1 + edges[b + 1]) / 2));
  let best = null;
  mids.forEach((m, b) => {
    const s = summarize(actual, actual.map(() => m), cuts);
    if (!best || s.within_one_band > best.within_one_band) best = { band: labels[b], score: m, ...s };
  });
  const { confusion, ...rest } = best;
  return rest;
}

// Seeded, so a gate verdict reproduces.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Within-one-band difference (A - B, in points) with a 95% interval from a
// DATE-BLOCK bootstrap: whole observation dates are resampled, because one
// night's weather or event moves every reading taken that night, and a
// row-level bootstrap would pretend those readings were independent.
function pairedDateBootstrap(rows, hitA, hitB, { resamples = BAND_GATE.bootstrapResamples, seed = 20260925 } = {}) {
  const byDate = new Map();
  rows.forEach((r, i) => {
    if (!byDate.has(r.date)) byDate.set(r.date, { n: 0, a: 0, b: 0 });
    const d = byDate.get(r.date);
    d.n++;
    d.a += hitA[i] ? 1 : 0;
    d.b += hitB[i] ? 1 : 0;
  });
  const blocks = [...byDate.values()];
  const total = blocks.reduce((s, d) => ({ n: s.n + d.n, a: s.a + d.a, b: s.b + d.b }), { n: 0, a: 0, b: 0 });
  const point = total.n ? ((total.a - total.b) / total.n) * 100 : null;
  if (blocks.length < 2) return { delta: point, ci95: null, dates: blocks.length };
  const rand = mulberry32(seed);
  const draws = [];
  for (let s = 0; s < resamples; s++) {
    let n = 0;
    let a = 0;
    let b = 0;
    for (let j = 0; j < blocks.length; j++) {
      const d = blocks[Math.floor(rand() * blocks.length)];
      n += d.n; a += d.a; b += d.b;
    }
    draws.push(((a - b) / n) * 100);
  }
  draws.sort((x, y) => x - y);
  const q = (p) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * (draws.length - 1))))];
  const r2 = (x) => Math.round(x * 100) / 100;
  return { delta: r2(point), ci95: [r2(q(0.025)), r2(q(0.975))], dates: blocks.length };
}

const HOUR_GROUPS = [
  ['late_night_0_5', 0, 5], ['morning_6_10', 6, 10], ['midday_11_14', 11, 14],
  ['afternoon_15_16', 15, 16], ['dinner_17_20', 17, 20], ['evening_21_23', 21, 23],
];
const hourGroup = (h) => (HOUR_GROUPS.find(([, lo, hi]) => h >= lo && h <= hi) || ['?'])[0];
const depthBucket = (n) => (n === 0 ? '0' : n === 1 ? '1' : n <= 4 ? '2-4' : n <= 9 ? '5-9' : n <= 19 ? '10-19' : '20+');

const SLICES = {
  city: (r) => r.city,
  hour: (r) => String(r.hour).padStart(2, '0'),
  hour_group: (r) => hourGroup(r.hour),
  actual_band: (r, cuts, labels) => labels[bandOf(r.y, cuts)],
  category: (r) => r.venueCategory || '(none)',
  category_guess_agrees: (r) => (r.guessedCategory === r.venueCategory ? 'agrees' : 'differs'),
  prior_live_readings: (r) => depthBucket(r.priorLive),
  offset_served: (r) => (r.offset === null ? 'no_offset' : 'offset'),
  date: (r) => r.date,
};

// predictors: { name: number[] } aligned with rows. Returns the headline for
// every predictor and, per slice, the same summary per level.
function report(rows, predictors, cuts, labels, { slices = Object.keys(SLICES) } = {}) {
  const actual = rows.map((r) => r.y);
  const out = { rows: rows.length, dates: new Set(rows.map((r) => r.date)).size, overall: {}, slices: {} };
  for (const [name, pred] of Object.entries(predictors)) out.overall[name] = summarize(actual, pred, cuts);
  for (const s of slices) {
    const key = SLICES[s];
    const groups = new Map();
    rows.forEach((r, i) => {
      const g = key(r, cuts, labels);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    });
    out.slices[s] = {};
    for (const g of [...groups.keys()].sort()) {
      const idx = groups.get(g);
      out.slices[s][g] = { n: idx.length };
      for (const [name, pred] of Object.entries(predictors)) {
        const m = summarize(idx.map((i) => actual[i]), idx.map((i) => pred[i]), cuts);
        out.slices[s][g][name] = { within_one_band: m.within_one_band, band_exact: m.band_exact, mae: m.mae, bias: m.bias };
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

// Which live rows a model has never seen: the candidate declares the first
// held-out date; the incumbent must have stopped learning before it.
function incumbentDataThrough(meta) {
  const th = meta && meta.time_holdout;
  if (th && typeof th.training_live_through === 'string' && dayNumber(th.training_live_through) !== null) {
    return { date: th.training_live_through, basis: 'time_holdout.training_live_through' };
  }
  if (meta && typeof meta.trained_at === 'string') {
    return { date: meta.trained_at.slice(0, 10), basis: 'trained_at (no model sees data from after it was trained)' };
  }
  return { date: null, basis: 'unknown' };
}

function bandGate({ rows, cuts, labels, candidate, incumbent, naive, rule, fromDate, incumbentThrough, limits = BAND_GATE }) {
  const hits = (pred) => rows.map((r, i) => Math.abs(bandOf(r.y, cuts) - bandOf(pred[i], cuts)) <= 1);
  const actual = rows.map((r) => r.y);
  const cand = summarize(actual, candidate, cuts);
  const inc = summarize(actual, incumbent, cuts);
  const nai = summarize(actual, naive, cuts);
  const rul = summarize(actual, rule, cuts);
  const dates = new Set(rows.map((r) => r.date)).size;
  const vsInc = pairedDateBootstrap(rows, hits(candidate), hits(incumbent));
  const vsNaive = pairedDateBootstrap(rows, hits(candidate), hits(naive));
  const vsRule = pairedDateBootstrap(rows, hits(candidate), hits(rule));

  const perCity = {};
  const cities = [...new Set(rows.map((r) => r.city))].sort();
  let cityPass = true;
  for (const c of cities) {
    const idx = rows.map((r, i) => (r.city === c ? i : -1)).filter((i) => i >= 0);
    const a = idx.map((i) => actual[i]);
    const cm = summarize(a, idx.map((i) => candidate[i]), cuts);
    const im = summarize(a, idx.map((i) => incumbent[i]), cuts);
    const delta = Math.round((cm.within_one_band - im.within_one_band) * 10) / 10;
    const binding = idx.length >= limits.cityMinRows;
    const ok = !binding || delta >= limits.cityMaxRegression;
    if (!ok) cityPass = false;
    perCity[c] = { n: idx.length, candidate: cm.within_one_band, incumbent: im.within_one_band, delta, binding, pass: ok };
  }

  const unseen = incumbentThrough && fromDate ? incumbentThrough < fromDate : false;
  const criteria = {
    sample: { pass: rows.length >= limits.minRows && dates >= limits.minDates, rows: rows.length, dates, need: `>= ${limits.minRows} rows over >= ${limits.minDates} dates` },
    incumbent_unseen: { pass: unseen, incumbent_data_through: incumbentThrough, from: fromDate, need: 'the incumbent stopped learning before the first held-out date' },
    beats_incumbent: { pass: vsInc.delta > 0 && !!vsInc.ci95 && vsInc.ci95[0] > limits.incumbentCiLowerMin, ...vsInc, need: `delta > 0 and CI95 low > ${limits.incumbentCiLowerMin}pp` },
    // Beating the curve is the "something real" bar, and it is argued in
    // bands AND in band distance: a model that wins within_one_band by hedging
    // toward Not Busy loses band_mae to the curve and fails here.
    beats_naive_curve: {
      pass: vsNaive.delta > 0 && !!vsNaive.ci95 && vsNaive.ci95[0] > limits.naiveCiLowerMin && cand.band_mae <= nai.band_mae,
      ...vsNaive,
      candidate_band_mae: cand.band_mae,
      naive_band_mae: nai.band_mae,
      need: `delta > 0, CI95 low > ${limits.naiveCiLowerMin}pp, and band_mae no worse than the curve's`,
    },
    not_worse_than_rule_engine: { pass: vsRule.delta >= 0, ...vsRule, need: 'delta >= 0' },
    no_city_regression: { pass: cityPass, per_city: perCity, need: `every city with >= ${limits.cityMinRows} rows within ${limits.cityMaxRegression}pp of the incumbent` },
    point_error_guard: { pass: cand.mae <= inc.mae + limits.maeSlack, candidate_mae: cand.mae, incumbent_mae: inc.mae, need: `MAE <= incumbent + ${limits.maeSlack}` },
  };
  const pass = Object.values(criteria).every((c) => c.pass);
  return {
    pass,
    metric: 'within_one_band',
    population: 'live-labelled realtime rows (label_source = live) in the time holdout, where the served baseline is positive (the model path)',
    window_from: fromDate,
    criteria,
    candidate: cand,
    incumbent: inc,
    naive_curve: nai,
    rule_engine: rul,
    // Not a criterion. The number a constant answer gets on these rows, so a
    // within_one_band figure is never read without knowing what it costs to fake.
    hedge_reference: bestConstantBand(actual, cuts, labels || labelsFromCuts(cuts)),
    limits,
  };
}

// Labels in band order, for callers that have only the cuts.
function labelsFromCuts(cuts) {
  return cuts.map((_, i) => `band_${i}`).concat([`band_${cuts.length}`]);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { legacy: false, gate: false, slices: false, category: 'guess' };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unrecognised argument ${a}`);
    const [, k, v] = m;
    if (k === 'legacy') args.legacy = true;
    else if (k === 'gate') args.gate = true;
    else if (k === 'slices') args.slices = true;
    else if (['train', 'holdout', 'model', 'incumbent', 'from', 'to', 'out', 'rows-out', 'category', 'qmap'].includes(k)) args[k] = v;
    else throw new Error(`unrecognised argument --${k}`);
  }
  return args;
}

function fmt(m) {
  return `${String(m.n).padStart(6)}  w1b ${String(m.within_one_band).padStart(5)}%  exact ${String(m.band_exact).padStart(5)}%  `
    + `bandMAE ${String(m.band_mae).padStart(5)}  MAE ${String(m.mae).padStart(6)}  bias ${String(m.bias).padStart(6)}  `
    + `w15 ${String(m.within_15).padStart(5)}%`;
}

// --slices: every slice of a section as within-one-band / band exact / MAE,
// one column per predictor.
function printSlices(section, names = ['city', 'hour', 'hour_group', 'actual_band', 'category', 'prior_live_readings']) {
  const preds = Object.keys(section.model_served_rows.overall);
  const short = (p) => p.replace(/^model_/, '').replace(/^reference_/, 'ref_').replace(/:.*$/, (m) => (m.length > 12 ? `:${m.slice(1, 6)}` : m)).slice(0, 21);
  for (const name of names) {
    const groups = section.model_served_rows.slices[name];
    if (!groups) continue;
    console.log(`\n  by ${name}  (within one band % / band exact % / MAE)`);
    console.log(`  ${'level'.padEnd(18)}${'n'.padStart(7)}  ${preds.map((p) => short(p).padStart(22)).join('')}`);
    for (const [level, row] of Object.entries(groups)) {
      console.log(`  ${String(level).padEnd(18)}${String(row.n).padStart(7)}  `
        + preds.map((p) => `${row[p].within_one_band}/${row[p].band_exact}/${row[p].mae}`.padStart(22)).join(''));
    }
  }
}

function writeRowsCsv(file, rows, cols) {
  const lines = [cols.map(([h]) => h).join(',')];
  for (const r of rows) lines.push(cols.map(([, f]) => { const v = f(r); return v === null || v === undefined ? '' : v; }).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

async function main(argv = process.argv.slice(2)) {
  pinUtcClock();
  isolateFromDatabases();
  const args = parseArgs(argv);
  const trainDir = __dirname;
  const files = [
    args.train || path.join(trainDir, 'training_data.csv'),
    args.holdout || path.join(trainDir, 'holdout_data.csv'),
  ].filter((f) => f !== '-');
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`${f} does not exist. Run export_training_data.js first.`);

  const modelDir = args.model || DEFAULT_MODELS_DIR;
  const incumbentDir = args.incumbent || (args.gate ? path.join(DEFAULT_MODELS_DIR, 'incumbent') : null);

  const t0 = Date.now();
  const corpus = await readCorpus(files, { legacyCities: args.legacy ? LEGACY_REFERENCE_CITIES : [] });
  console.log(`[BandEval] read ${corpus.census.rows.toLocaleString()} rows (${corpus.census.weekly.toLocaleString()} weekly, `
    + `${corpus.census.realtime.toLocaleString()} realtime: ${JSON.stringify(corpus.census.bySource)}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const art = await loadArtifact(modelDir);
  const inc = incumbentDir ? await loadArtifact(incumbentDir) : null;
  const crowdEngine = require(CROWD_ENGINE_PATH);
  const { cuts, labels } = bandLadder(crowdEngine.getLabel);

  // THE WINDOW. A gate reads it from the candidate; a report defaults to the
  // day after the scored model's own training data ended.
  let fromDate = args.from || null;
  if (args.gate) {
    const declared = art.meta.time_holdout && art.meta.time_holdout.from_date;
    if (!declared) throw new Error('--gate: the candidate declares no time_holdout.from_date, so there is no set of live rows it provably never trained on. Re-run prepare_features.py (FLOCK_TIME_HOLDOUT_DAYS) and train again.');
    if (args.from && args.from !== declared) throw new Error(`--from=${args.from} disagrees with the candidate's time_holdout.from_date ${declared}.`);
    fromDate = declared;
  }
  if (!fromDate) {
    const through = incumbentDataThrough(art.meta).date;
    const next = through ? new Date(Date.UTC(...through.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) + 86400000) : null;
    fromDate = next ? next.toISOString().slice(0, 10) : '0000-01-01';
  }
  const toDate = args.to || '9999-12-31';
  const inWindow = (r) => r.date >= fromDate && r.date <= toDate;

  const helpers = { I: art.I, crowdEngine };
  const qmap = args.qmap === undefined ? undefined : args.qmap !== 'false';
  const sections = {};
  const perRow = [];

  async function evaluate(label, rows, window) {
    const prepared = prepareRows(rows, corpus, helpers, { category: args.category });
    const mine = await scoreArtifact(art, prepared, { qmap });
    const theirs = inc ? await scoreArtifact(inc, prepared, { qmap }) : null;
    const served = prepared.map((r, i) => r.smoothed > 0 && mine.rows[i].ml);
    const mlRows = prepared.filter((_, i) => served[i]);
    const pick = (arr) => arr.filter((_, i) => served[i]);
    const curve = prepared.map((r) => (r.rawCurve === null ? 0 : r.rawCurve));
    const curveOffset = prepared.map((r, i) => (r.offset === null ? curve[i] : Math.max(0, Math.min(100, Math.round(curve[i] + r.offset)))));
    // REFERENCE, NOT SERVED: the model as served, except where the venue was
    // read live in the previous two hours, where that reading is carried
    // forward (nowcast in prepareRows).
    const nowcastElseServed = prepared.map((r, i) => (r.nowcast === null ? mine.rows[i].served : r.nowcast));
    const predictors = {
      [`model_served:${mine.version}`]: pick(mine.rows.map((x) => x.served)),
      [`model_reconstructed:${mine.version}`]: pick(mine.rows.map((x) => x.reconstructed)),
      [`model_mapped:${mine.version}`]: pick(mine.rows.map((x) => x.mapped)),
      [`model_offset:${mine.version}`]: pick(mine.rows.map((x) => x.withOffset)),
      rule_engine: pick(prepared.map((r) => r.rule)),
      naive_curve: pick(curve),
      curve_plus_offset: pick(curveOffset),
      reference_nowcast_else_served: pick(nowcastElseServed),
    };
    if (theirs) predictors[`model_served:${theirs.version}`] = pick(theirs.rows.map((x) => x.served));
    const allRows = {
      app_as_shown: prepared.map((r, i) => mine.rows[i].served),
      rule_engine: prepared.map((r) => r.rule),
      naive_curve: curve,
    };
    const mlActual = mlRows.map((r) => r.y);
    sections[label] = {
      window,
      all_live_rows: report(prepared, allRows, cuts, labels, { slices: ['city'] }),
      model_served_rows: report(mlRows, predictors, cuts, labels),
      hedge_reference: mlActual.length ? bestConstantBand(mlActual, cuts, labels) : null,
      nowcast_coverage: {
        rows: mlRows.filter((r) => r.nowcast !== null).length,
        of: mlRows.length,
        by_age_hours: mlRows.reduce((acc, r) => {
          if (r.nowcastAgeHours !== null) acc[r.nowcastAgeHours] = (acc[r.nowcastAgeHours] || 0) + 1;
          return acc;
        }, {}),
      },
      qmap_applied: mine.qmapApplied,
      rows_without_served_baseline: prepared.length - mlRows.length,
      rows_skipped_clock_disagreement: prepared.skipped,
    };
    prepared.forEach((r, i) => perRow.push({ section: label, r, mine: mine.rows[i], theirs: theirs ? theirs.rows[i] : null }));
    return { prepared, mine, theirs, served, mlRows, curve };
  }

  const liveResult = await evaluate('live_time_holdout', corpus.live.filter(inWindow), { from: fromDate, to: toDate });
  if (args.legacy) {
    // Unknown provenance, collected 2026-03-10..05-18 in the three holdout
    // cities: the population every gate before September was scored on. A
    // labelled reference for continuity, never a gate input.
    const dates = corpus.legacy.map((r) => r.date).filter(Boolean).sort();
    await evaluate('legacy_reference_holdout_cities', corpus.legacy,
      { from: dates[0] || null, to: dates[dates.length - 1] || null, provenance: 'unknown (pre label_source)' });
  }

  // Print.
  for (const [label, s] of Object.entries(sections)) {
    console.log(`\n[BandEval] ${label}: window ${s.window.from} .. ${s.window.to}, ${s.model_served_rows.rows} model-served rows over ${s.model_served_rows.dates} dates `
      + `(${s.rows_without_served_baseline} more answered by the rule engine for want of a baseline, `
      + `${s.rows_skipped_clock_disagreement} skipped: date and weekday disagree); quantile map ${s.qmap_applied ? 'ON' : 'off'}`);
    for (const [name, m] of Object.entries(s.model_served_rows.overall)) console.log(`  ${name.padEnd(36)} ${fmt(m)}`);
    if (s.hedge_reference) {
      console.log(`  ${`reference_constant:${s.hedge_reference.band}`.padEnd(36)} ${fmt(s.hedge_reference)}  (in-sample; what a constant answer buys)`);
    }
    console.log(`  nowcast reference covers ${s.nowcast_coverage.rows} of ${s.nowcast_coverage.of} rows `
      + `(reading age in hours: ${JSON.stringify(s.nowcast_coverage.by_age_hours)})`);
    console.log('  what the app shows on every live row (model where it serves, rule engine elsewhere):');
    for (const [name, m] of Object.entries(s.all_live_rows.overall)) console.log(`  ${name.padEnd(36)} ${fmt(m)}`);
    if (args.slices) printSlices(s);
  }

  let gateResult = null;
  if (args.gate) {
    if (!inc) throw new Error('--gate needs an incumbent (models/incumbent/ or --incumbent).');
    const { prepared, mine, theirs, served, mlRows, curve } = liveResult;
    const pick = (arr) => arr.filter((_, i) => served[i]);
    gateResult = bandGate({
      rows: mlRows,
      cuts,
      labels,
      candidate: pick(mine.rows.map((x) => x.served)),
      incumbent: pick(theirs.rows.map((x) => x.served)),
      naive: pick(curve),
      rule: pick(prepared.map((r) => r.rule)),
      fromDate,
      incumbentThrough: incumbentDataThrough(inc.meta).date,
    });
    gateResult.candidate_version = art.meta.model_version;
    gateResult.incumbent_version = inc.meta.model_version;
    gateResult.incumbent_data_through_basis = incumbentDataThrough(inc.meta).basis;
    gateResult.quantile_map = { candidate: mine.qmapApplied, incumbent: theirs.qmapApplied };
    console.log(`\n[BandEval] BAND GATE: ${gateResult.pass ? 'PASS' : 'FAIL'}`);
    for (const [k, c] of Object.entries(gateResult.criteria)) {
      const detail = c.delta !== undefined ? ` delta ${c.delta}pp CI95 ${JSON.stringify(c.ci95)}` : '';
      console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${k}${detail}  (${c.need})`);
    }
    writeBandGate(path.join(path.resolve(modelDir), 'model_metadata.json'), gateResult);
  }

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify({
      generated_at: new Date().toISOString(),
      files: corpus.census.files,
      census: corpus.census,
      model: { dir: art.dir, version: art.meta.model_version },
      incumbent: inc ? { dir: inc.dir, version: inc.meta.model_version } : null,
      ladder: { cuts, labels },
      sections,
      band_gate: gateResult,
    }, null, 2));
    console.log(`\n[BandEval] report -> ${args.out}`);
  }
  if (args['rows-out']) {
    writeRowsCsv(args['rows-out'], perRow, [
      ['section', (x) => x.section], ['venue_id', (x) => x.r.venueId], ['city', (x) => x.r.city],
      ['date', (x) => x.r.date], ['dow', (x) => x.r.dow], ['hour', (x) => x.r.hour],
      ['category', (x) => x.r.venueCategory], ['guessed_category', (x) => x.r.guessedCategory],
      ['y', (x) => x.r.y], ['vendor_forecast', (x) => x.r.vendorForecast],
      ['curve', (x) => x.r.rawCurve], ['smoothed', (x) => x.r.smoothed],
      ['offset', (x) => x.r.offset], ['offset_readings', (x) => x.r.offsetReadings], ['prior_live', (x) => x.r.priorLive],
      ['neighbor_count', (x) => x.r.neighbors.count], ['neighbor_mean', (x) => Math.round(x.r.neighbors.mean * 100) / 100],
      ['temperature', (x) => (x.r.weather ? x.r.weather.temp : null)], ['events_observed', (x) => (x.r.events.observed ? 1 : 0)],
      ['rule', (x) => x.r.rule], ['ml', (x) => (x.mine.ml ? 1 : 0)],
      ['raw_delta', (x) => (x.mine.ml ? Math.round(x.mine.rawDelta * 1000) / 1000 : null)],
      ['reconstructed', (x) => (x.mine.ml ? x.mine.reconstructed : null)], ['mapped', (x) => (x.mine.ml ? x.mine.mapped : null)],
      ['with_offset', (x) => (x.mine.ml ? x.mine.withOffset : null)], ['served', (x) => x.mine.served],
      ['incumbent_served', (x) => (x.theirs ? x.theirs.served : null)],
      ['nowcast', (x) => x.r.nowcast], ['nowcast_age_hours', (x) => x.r.nowcastAgeHours],
    ]);
    console.log(`[BandEval] rows -> ${args['rows-out']}`);
  }
  return { sections, gate: gateResult };
}

// The band gate may VETO a pass and may confirm one; it never overrides the
// point gate. quick_eval.py leaves overall_pass false with verdict
// pending_band_gate and records its own verdict as point_gate_pass; this sets
// overall_pass to (point_gate_pass AND band gate), so an artifact is loadable
// only when both have run and both passed.
function writeBandGate(metaPath, gateResult) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const g = meta.ship_gate;
  if (!g || typeof g.point_gate_pass !== 'boolean') {
    throw new Error(`${metaPath} carries no ship_gate.point_gate_pass: quick_eval.py (with the band gate) has not run on this artifact, so there is no point verdict to combine with.`);
  }
  if (g.band_gate_required === false) {
    throw new Error(`${metaPath} was gated with ML_ALLOW_NO_BAND_GATE; refusing to rewrite a verdict that was taken without this gate on purpose.`);
  }
  // When quick_eval could not line the incumbent up by its pickle it deferred
  // its incumbent arms here; this verdict's beats_incumbent and
  // point_error_guard, on identical live readings, are then the ones that count.
  g.band_gate = { ...gateResult, decides_deferred_incumbent_arms: g.incumbent_deferred_to_band_gate === true };
  g.overall_pass = Boolean(g.point_gate_pass && gateResult.pass);
  g.verdict = g.overall_pass ? 'ship' : 'do_not_ship';
  g.band_gate_status = gateResult.pass ? 'pass' : 'fail';
  const tmp = `${metaPath}.${process.pid}.bandgate`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, metaPath);
  console.log(`[BandEval] wrote ship_gate.band_gate; overall_pass = point (${g.point_gate_pass}) AND band (${gateResult.pass}) = ${g.overall_pass}`);
}

module.exports = {
  parseCsvLine,
  readCorpus,
  isolateFromDatabases,
  pinUtcClock,
  wallClock,
  dayNumber,
  baselineRowsFor,
  makeNeighborIndex,
  makeOffsetLookup,
  median,
  loadArtifact,
  prepareRows,
  scoreArtifact,
  bandLadder,
  bandOf,
  summarize,
  bestConstantBand,
  pairedDateBootstrap,
  report,
  bandGate,
  writeBandGate,
  incumbentDataThrough,
  main,
  BAND_GATE,
  OFFSET_WINDOW_HOURS,
  OFFSET_MAX_READINGS,
  NOWCAST_MAX_AGE_HOURS,
  NOWCAST_WEIGHT_BY_AGE,
  LEGACY_EVENT_TYPE_ALIASES,
  REQUIRED_COLUMNS,
  OFFLINE_DATABASE_URL,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[BandEval] ${err.message}`);
    process.exit(1);
  });
}
