// ONE LIVE SENSOR READING, FOLDED INTO THE HOURLY HISTORY THE WAY THE SERVER
// FOLDS IT.
//
// GET /api/sensors/:placeId/history (backend/routes/sensors.js) answers one
// bucket per hour: the door count is the SUM of that hour's readings and every
// other figure is their AVERAGE, over `sample_count` readings. A live reading
// (venue_sensor_update) carries one interval's door count. Both venue screens
// used to REPLACE the current hour's bucket with that one reading, so the
// owner's "Today's Door Count", a sum over the buckets, fell from 412 to 184
// the moment the next reading came in, and came back on a refresh (venue audit
// 2026-10-03). Folding it in the server's way makes a live update and a reload
// tell the same story.

const AVERAGED = ['thermal_headcount', 'occupancy', 'occupancy_low', 'occupancy_high', 'dwell_minutes', 'noise_db'];

// A number, or a numeric STRING: the history endpoint returns its rows as node-pg
// reads them, and noise_db there is a Postgres numeric, which arrives as "70.00".
// Read as a number only, the hour's average looked missing and the first live
// reading replaced it outright (review 2026-10-03).
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

// Same local hour. The server buckets on date_trunc('hour'), which agrees with
// a local hour in every whole-hour time zone.
export function sameHour(tsA, tsB) {
  const a = new Date(tsA);
  const b = new Date(tsB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate() && a.getHours() === b.getHours();
}

// A reading as a bucket of one.
function bucketOf(payload) {
  const bucket = { recorded_at: payload.recorded_at, sample_count: 1, ir_beam_count: num(payload.ir_beam_count) };
  for (const key of AVERAGED) bucket[key] = num(payload[key]);
  return bucket;
}

// `history` with `payload` folded in: added to the current hour's bucket, or
// appended as a new one, keeping at most `cap` buckets.
export function foldSensorReading(history, payload, cap) {
  const list = Array.isArray(history) ? history : [];
  const last = list[list.length - 1];
  if (!last || !sameHour(last.recorded_at, payload.recorded_at)) {
    return [...list, bucketOf(payload)].slice(-cap);
  }
  const n = Number.isInteger(last.sample_count) && last.sample_count > 0 ? last.sample_count : 1;
  const merged = { ...last, sample_count: n + 1 };
  const count = num(payload.ir_beam_count);
  if (count !== null) merged.ir_beam_count = (num(last.ir_beam_count) || 0) + count;
  for (const key of AVERAGED) {
    const x = num(payload[key]);
    if (x === null) continue;
    const avg = num(last[key]);
    const next = avg === null ? x : (avg * n + x) / (n + 1);
    merged[key] = key === 'noise_db' ? Math.round(next * 100) / 100 : Math.round(next);
  }
  return [...list.slice(0, -1), merged];
}
