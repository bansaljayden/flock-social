// ---------------------------------------------------------------------------
// A SILENT FEED MUST NOT DROP THE STRICT OFFSET A WEEK EARLY.
//
// recentDeviationEntry's `fresh` used to require the deviation row's updated_at
// to be under seven days old. updated_at moves only when a collector run writes
// a live row, so a silent provider feed retired every venue's strict offset
// seven days after the last productive run, three weeks before the readings'
// own 28-day window (trailingOffsetBefore) would have. Replayed on 28 outage
// onsets, that cost 3.75 points of exact level on days 7 to 13 of a silence.
// `fresh` now means the row was read; each reading still ages out on its own
// clock, and the stored single offset (`data`, served with both switches off)
// keeps the seven-day limit.
//
// No database, no network. Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-offset-silent-feed';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const PREDICTOR = require.resolve('../services/mlPredictor');
const SWITCHES = ['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_QMAP_ENABLED', 'CROWD_NO_CURVE_FALLBACK'];
const DAY = 24 * 60 * 60 * 1000;

// The venue's offset readings: the last three Fridays at 20:00 and 21:00, each
// 12 points above the curve, as the builder stores them ({d, h, dev}).
const READINGS = [
  { d: '2026-10-09', h: 21, dev: 12 }, { d: '2026-10-09', h: 20, dev: 12 },
  { d: '2026-10-02', h: 21, dev: 12 }, { d: '2026-10-02', h: 20, dev: 12 },
  { d: '2026-09-25', h: 21, dev: 12 }, { d: '2026-09-25', h: 20, dev: 12 },
];

async function entryFor(row, env) {
  const saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
  for (const k of SWITCHES) delete process.env[k];
  Object.assign(process.env, env);
  const pool = require('../config/database');
  const realQuery = pool.query;
  pool.query = async () => ({ rows: row ? [row] : [] });
  try {
    delete require.cache[PREDICTOR];
    const p = require(PREDICTOR);
    return { entry: await p._internals.recentDeviationEntry('ChIJ-silent-feed'), I: p._internals };
  } finally {
    pool.query = realQuery;
    for (const k of SWITCHES) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function rowAged(days) {
  return {
    offset_pct: 12,
    n_readings: READINGS.length,
    updated_at: new Date(Date.now() - days * DAY),
    recent_readings: null,
    offset_readings: READINGS,
  };
}

test('a deviation row ten days stale still feeds the strict offset', async () => {
  const { entry, I } = await entryFor(rowAged(10), { CROWD_SERVE_MODE: 'curve_offset' });
  assert.equal(entry.fresh, true);
  const target = I.slotDayNumber('2026-10-16') * 24 + 20;
  const off = I.trailingOffsetBefore(entry.offsetReadings, target);
  assert.ok(off, 'the readings inside the 28-day window still give an offset');
  assert.equal(off.offset, 12);
  assert.equal(off.readings, READINGS.length);
});

test('the stored single offset keeps its seven-day limit', async () => {
  const stale = await entryFor(rowAged(10), { CROWD_SERVE_MODE: 'curve_offset' });
  assert.equal(stale.entry.data, null);
  const recent = await entryFor(rowAged(1), { CROWD_SERVE_MODE: 'curve_offset' });
  assert.ok(recent.entry.data);
  assert.equal(recent.entry.data.offset, 12);
});

test('readings still age out on their own clock', async () => {
  const { entry, I } = await entryFor(rowAged(40), { CROWD_SERVE_MODE: 'curve_offset' });
  assert.equal(entry.fresh, true);
  // Forty days after the newest reading, every reading is outside the window.
  const target = I.slotDayNumber('2026-11-20') * 24 + 20;
  assert.equal(I.trailingOffsetBefore(entry.offsetReadings, target), null);
});

test('no row, nothing fresh', async () => {
  const { entry } = await entryFor(null, { CROWD_SERVE_MODE: 'curve_offset' });
  assert.equal(entry.fresh, false);
  assert.equal(entry.offsetReadings, null);
});
