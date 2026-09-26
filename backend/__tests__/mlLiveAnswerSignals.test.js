// ---------------------------------------------------------------------------
// WHAT BESTTIME'S LIVE ANSWER SAYS ABOUT ITSELF IS STORED WITH THE READING.
//
// The live call returns analysis.hour_start (the hour the live value is
// measured for), venue_info.venue_open ('Open' / 'Closed') and
// venue_info.venue_current_localtime (the vendor's clock). bestTimeService
// used to read analysis.hour_analysis and analysis.venue_open, keys the live
// response does not have, so both were null on every call and nothing stored
// them anyway. Pinned here:
//
//   * the collector's mapping of each field, including every value it must
//     refuse rather than guess (liveAnswerColumns);
//   * that storeReading writes the three columns, and that the collector
//     declares them itself before its first insert (it deploys with the
//     BESTTIME service and can run before the main service boots 094);
//   * migration 094: additive, ASCII, the same three columns;
//   * the export carries them as columns 46-48, empty rather than invented.
//
// No database, no network. Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-live-answer';

const ML = path.join(__dirname, '..', 'scripts', 'ml');
const COLLECTOR_SRC = fs.readFileSync(path.join(ML, 'collectRealtime.js'), 'utf8');
const SERVICE_SRC = fs.readFileSync(path.join(ML, 'bestTimeService.js'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '094_live_answer_signals.sql'), 'utf8');

const { liveAnswerColumns, LIVE_LOCAL_TIME_MAX } = require('../scripts/ml/collectRealtime');
const exporter = require('../scripts/ml/train/export_training_data');

const cols = (live) => Object.fromEntries(liveAnswerColumns(live));

test('the live answer maps onto three columns, and anything unclean is NULL', () => {
  assert.deepEqual(cols({ hourStart: 21, venueOpen: 'Open', vendorLocalTime: 'Friday 2026-09-25 09:23PM' }),
    { live_hour_start: 21, live_venue_open: true, live_local_time: 'Friday 2026-09-25 09:23PM' });
  assert.deepEqual(cols({ hourStart: 0, venueOpen: ' closed ', vendorLocalTime: '' }),
    { live_hour_start: 0, live_venue_open: false, live_local_time: null });
  for (const h of [24, -1, 21.5, '21', null, undefined, NaN, true]) {
    assert.equal(cols({ hourStart: h }).live_hour_start, null, String(h));
  }
  for (const o of ['open now', 'Unknown', 1, 0, null, undefined, {}]) {
    assert.equal(cols({ venueOpen: o }).live_venue_open, null, String(o));
  }
  assert.equal(cols({ venueOpen: true }).live_venue_open, true);
  assert.equal(cols({ venueOpen: false }).live_venue_open, false);
  assert.equal(cols({ vendorLocalTime: 'x'.repeat(LIVE_LOCAL_TIME_MAX + 1) }).live_local_time, null,
    'too long for the column: NULL, not truncated');
  assert.deepEqual(cols(null), { live_hour_start: null, live_venue_open: null, live_local_time: null });
});

test('bestTimeService reads the fields where the live response carries them', () => {
  assert.match(SERVICE_SRC, /hourStart: data\.analysis\?\.hour_start \?\? null/);
  assert.match(SERVICE_SRC, /venueOpen: data\.venue_info\?\.venue_open/);
  assert.match(SERVICE_SRC, /vendorLocalTime: data\.venue_info\?\.venue_current_localtime/);
  assert.doesNotMatch(SERVICE_SRC, /hour: data\.analysis\?\.hour_analysis/, 'the key the live response never had');
});

test('storeReading writes the three columns, and the collector declares them before inserting', () => {
  const body = COLLECTOR_SRC.slice(COLLECTOR_SRC.indexOf('async function storeReading('));
  const columns = body.slice(0, body.indexOf('withCorpusWriteLock('));
  assert.match(columns, /\.\.\.liveAnswerColumns\(live\)/);
  const ensure = COLLECTOR_SRC.slice(COLLECTOR_SRC.indexOf('async function ensureHolidayColumns('));
  const ensureBody = ensure.slice(0, ensure.indexOf('\n}\n') >= 0 ? ensure.indexOf('\n}\n') : ensure.indexOf('\r\n}\r\n'));
  for (const [c, type] of [['live_hour_start', 'SMALLINT'], ['live_venue_open', 'BOOLEAN'], ['live_local_time', 'VARCHAR\\(48\\)']]) {
    assert.match(ensureBody, new RegExp(`ADD COLUMN IF NOT EXISTS ${c} ${type}`), c);
    assert.match(MIGRATION, new RegExp(`ADD COLUMN IF NOT EXISTS ${c} ${type};`), `094: ${c}`);
    assert.match(MIGRATION, new RegExp(`-- @requires column ml_training_data\\.${c}`), `094 declares ${c}`);
  }
  assert.ok(/^[\x00-\x7F]*$/.test(MIGRATION), 'ASCII only: the boot-safety server is WIN1252');
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /\b(DROP|DELETE|UPDATE|NOT NULL|DEFAULT)\b/i);
  assert.equal(`${liveAnswerColumns({}).map(([c]) => c)}`, 'live_hour_start,live_venue_open,live_local_time');
});

test('the export carries them as its last three columns, empty when nothing was recorded', () => {
  const header = exporter.HEADER.split(',');
  assert.deepEqual(header.slice(-3), ['live_hour_start', 'live_venue_open', 'live_local_time']);
  for (const c of ['live_hour_start', 'live_venue_open', 'live_local_time']) {
    assert.ok(Object.prototype.hasOwnProperty.call(exporter.OPTIONAL_COLUMNS, c), `${c} is probed, not assumed`);
  }
  const base = { venue_id: 1, collection_mode: 'realtime', google_types: [] };
  const at = (row, c) => exporter.rowToCsv(row).split(',')[header.indexOf(c)];
  assert.equal(at({ ...base, live_hour_start: 21, live_venue_open: true, live_local_time: 'Fri 09:23PM' }, 'live_hour_start'), '21');
  assert.equal(at({ ...base, live_venue_open: false }, 'live_venue_open'), '0');
  assert.equal(at({ ...base, live_venue_open: true }, 'live_venue_open'), '1');
  assert.equal(at({ ...base }, 'live_venue_open'), '', 'unrecorded is empty, not closed');
  assert.equal(at({ ...base, live_hour_start: 0 }, 'live_hour_start'), '0', 'midnight is an hour');
  assert.equal(at({ ...base, live_hour_start: 31 }, 'live_hour_start'), '');
  assert.equal(at({ ...base }, 'live_local_time'), '');
  assert.equal(exporter.rowToCsv(base).split(',').length, header.length);
  const q = exporter.cityQuery('lehigh', { live_hour_start: false, live_venue_open: false, live_local_time: false });
  assert.match(q.text, /NULL AS live_hour_start/);
  assert.match(q.text, /NULL AS live_venue_open/);
  assert.match(q.text, /NULL AS live_local_time/);
});
