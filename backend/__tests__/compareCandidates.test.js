// ---------------------------------------------------------------------------
// RULE (b) OF THE HARVEST-INCLUSIVE CANDIDATE (scripts/ml/train/compareCandidates.js).
//
// Two bandEval.js --gate runs, one per candidate, each on its own export,
// each writing --rows-out. The comparison takes the gate's population from
// both files (live_time_holdout, ml = 1, the gate's six cities), pairs the rows
// by (venue_id, date, hour), and runs the gate's own date-paired bootstrap on
// within-10. It refuses rather than compares when the two runs did not score
// the same readings. Synthetic rows files under os.tmpdir(); no database, no
// network. Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const B = require('../scripts/ml/train/bandEval');
const C = require('../scripts/ml/train/compareCandidates');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'ml', 'train', 'compareCandidates.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-candidates-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// The rows file's columns as bandEval.js writeRowsCsv writes them today.
const HEADER = [
  'section', 'venue_id', 'city', 'date', 'dow', 'hour', 'category', 'guessed_category', 'y', 'vendor_forecast',
  'curve', 'smoothed', 'offset', 'offset_readings', 'prior_live', 'neighbor_count', 'neighbor_mean', 'temperature',
  'events_observed', 'rule', 'ml', 'raw_delta', 'reconstructed', 'mapped', 'with_offset', 'served', 'incumbent_served',
  'nowcast', 'nowcast_age_hours', 'served_nowcast_reading', 'served_nowcast_lag_hours', 'served_model',
  'served_curve_offset', 'served_model_nowcast', 'served_curve_offset_nowcast', 'served_model_when_fresh',
  'served_model_when_fresh_nowcast', 'fresh_reading',
];

// Before the label quarantine's window (services/labelQuarantine.json): the
// readings of 23 October to 25 November are the provider's own forecast.
const DATES = Array.from({ length: 10 }, (_, i) => `2026-09-${String(4 + i).padStart(2, '0')}`);
const HOURS = [12, 15, 18, 20, 22];
const VENUES_PER_CITY = 4;
const ROWS_PER_DATE = B.BAND_GATE_CITIES.length * VENUES_PER_CITY * HOURS.length; // 120

const dowOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const HIT = 3;   // |served - y| = 3: within 10
const MISS = 25; // |served - y| = 25: not

// The gate population: 10 dates x 6 cities x 4 venues x 5 hours = 1,200
// rows, labels 10..69, the registered candidate within 10 on every other row.
function population() {
  const rows = [];
  DATES.forEach((date, d) => {
    B.BAND_GATE_CITIES.forEach((city, c) => {
      for (let v = 0; v < VENUES_PER_CITY; v++) {
        for (const hour of HOURS) {
          const venueId = String(1000 + c * 100 + v);
          const y = ((Number(venueId) * 7 + hour * 13 + d * 5) % 60) + 10;
          const i = rows.length;
          rows.push({ section: 'live_time_holdout', venue_id: venueId, city, date, hour, y, ml: 1, served: y + (i % 2 === 0 ? HIT : MISS), d });
        }
      }
    });
  });
  return rows;
}

const clone = (rows) => rows.map((r) => ({ ...r }));
const isHit = (r) => Math.abs(r.served - r.y) <= 10;

function line(r) {
  const v = {
    category: 'bar', guessed_category: 'bar', vendor_forecast: r.y, curve: 40, smoothed: r.ml ? 40 : 0, offset: '',
    offset_readings: 0, prior_live: 3, neighbor_count: 12, neighbor_mean: 33.5, temperature: 51.2, events_observed: 1,
    rule: 45, raw_delta: r.ml ? 0.25 : '', reconstructed: r.ml ? r.served : '', mapped: r.ml ? r.served : '',
    with_offset: r.ml ? r.served : '', incumbent_served: 50, nowcast: '', nowcast_age_hours: '',
    served_nowcast_reading: '', served_nowcast_lag_hours: '', served_model: r.served, served_curve_offset: 40,
    served_model_nowcast: r.served, served_curve_offset_nowcast: 40, served_model_when_fresh: 40,
    served_model_when_fresh_nowcast: 40, fresh_reading: 0,
    ...r,
    dow: dowOf(r.date),
  };
  return HEADER.map((h) => (v[h] === undefined || v[h] === null ? '' : v[h])).join(',');
}

let seq = 0;
// A rows file as bandEval.js --rows-out leaves it: the CSV and its replay stamp
// (services/labelQuarantine.js writeReplayStamp), unless `stamp: false`.
function write(rows, { header = HEADER.join(','), extraLines = [], stamp = true } = {}) {
  const file = path.join(TMP, `rows_${++seq}.csv`);
  fs.writeFileSync(file, [header, ...rows.map(line), ...extraLines].join('\n') + '\n');
  if (stamp) require('../services/labelQuarantine').writeReplayStamp(file);
  return file;
}

// The challenger's rows with `served` moved so that `gain` of the registered
// candidate's misses on each date become hits (a negative gain turns hits into misses).
function shiftHits(rows, gainByDate) {
  const out = clone(rows);
  DATES.forEach((_, d) => {
    let gain = gainByDate[d] || 0;
    for (const r of out) {
      if (r.d !== d || gain === 0) continue;
      if (gain > 0 && !isHit(r)) { r.served = r.y + HIT; gain--; } else if (gain < 0 && isHit(r)) { r.served = r.y + MISS; gain++; }
    }
  });
  return out;
}

async function refusal(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof C.Refusal, `expected a Refusal, got ${err && err.stack}`);
    return err;
  }
  throw new assert.AssertionError({ message: 'expected the comparison to be refused' });
}

// ── The verdict ───────────────────────────────────────────────────────────────

test('identical files: every row pairs, delta 0, and the registered candidate stands', async () => {
  const rows = population();
  const file = write(rows);
  const r = await C.compareFiles(file, write(rows));
  assert.equal(r.pairing.paired, rows.length);
  assert.equal(r.pairing.only_in_registered, 0);
  assert.equal(r.pairing.only_in_challenger, 0);
  assert.equal(r.pairing.y_mismatches, 0);
  assert.equal(r.within_10.registered, 50);
  assert.equal(r.within_10.challenger, 50);
  assert.equal(r.bootstrap.delta, 0);
  assert.deepEqual(r.bootstrap.ci95, [0, 0]);
  assert.equal(r.bootstrap.n, rows.length);
  assert.equal(r.bootstrap.dates, DATES.length);
  assert.equal(r.bootstrap.resamples, B.BAND_GATE.bootstrapResamples);
  assert.equal(r.clears_b, false);
  assert.equal(r.verdict, C.VERDICT_STANDS);
  assert.equal(r.registered.window.from, DATES[0]);
  assert.equal(r.registered.window.to, DATES[DATES.length - 1]);
});

test('a challenger better on most dates clears (b), on the gate\'s own bootstrap with its defaults', async () => {
  const reg = population();
  // +24 hits on nine dates (of 120 rows each), -2 on the tenth.
  const chal = shiftHits(reg, [24, 24, 24, 24, 24, 24, 24, 24, 24, -2]);
  const r = await C.compareFiles(write(reg), write(chal));
  assert.equal(r.verdict, C.VERDICT_CLEARS);
  assert.equal(r.clears_b, true);
  assert.ok(r.bootstrap.delta > 0);
  assert.ok(r.bootstrap.ci95[0] > 0, `CI95 ${JSON.stringify(r.bootstrap.ci95)}`);
  // Exactly bandEval.pairedDateBootstrap(rows, challengerHits, registeredHits)
  // with no options: the gate's resamples and seed.
  const expected = B.pairedDateBootstrap(reg, chal.map(isHit), reg.map(isHit));
  assert.equal(r.bootstrap.delta, expected.delta);
  assert.deepEqual(r.bootstrap.ci95, expected.ci95);
  assert.equal(r.bootstrap.dates, expected.dates);
  assert.equal(r.within_10.challenger, Math.round(((600 + 9 * 24 - 2) / 1200) * 1000) / 10);
});

test('a challenger better only by noise stands: a positive delta whose interval reaches zero does not clear', async () => {
  const reg = population();
  const chal = shiftHits(reg, [3, -3, 2, -1]); // net +1 hit over 1,200 rows
  const r = await C.compareFiles(write(reg), write(chal));
  assert.ok(r.bootstrap.delta > 0, `delta ${r.bootstrap.delta}`);
  assert.ok(r.bootstrap.ci95[0] <= 0, `CI95 ${JSON.stringify(r.bootstrap.ci95)}`);
  assert.equal(r.clears_b, false);
  assert.equal(r.verdict, C.VERDICT_STANDS);
});

test('a worse challenger stands', async () => {
  const reg = population();
  const chal = shiftHits(reg, DATES.map(() => -20));
  const r = await C.compareFiles(write(reg), write(chal));
  assert.ok(r.bootstrap.delta < 0);
  assert.equal(r.verdict, C.VERDICT_STANDS);
});

// ── The population ────────────────────────────────────────────────────────────

test('rows outside the six cities, in other sections, or off the model path are left out of both sides', async () => {
  const reg = population();
  // The registered file also carries rule-engine rows of its own.
  const regExtra = DATES.map((date) => ({ section: 'live_time_holdout', venue_id: '7001', city: 'philly', date, hour: 9, y: 30, ml: 0, served: 45 }));
  // The challenger carries rows that would change everything if counted: a
  // fill city it scores perfectly, a legacy section from March in a gate city
  // on the population's own venues, and rule-engine rows on new keys.
  const fill = DATES.map((date) => ({ section: 'live_time_holdout', venue_id: '8001', city: 'miami', date, hour: 19, y: 50, ml: 1, served: 50 }));
  const legacy = reg.slice(0, 40).map((r) => ({ ...r, section: 'legacy_reference_holdout_cities', date: '2026-03-15', served: r.y }));
  const ruleRows = DATES.map((date) => ({ section: 'live_time_holdout', venue_id: '9001', city: 'denver', date, hour: 13, y: 80, ml: 0, served: 10 }));
  const r = await C.compareFiles(write([...reg, ...regExtra]), write([...clone(reg), ...fill, ...legacy, ...ruleRows]));
  assert.equal(r.registered.population, reg.length);
  assert.equal(r.challenger.population, reg.length);
  assert.equal(r.registered.not_model_path, DATES.length);
  assert.equal(r.challenger.not_model_path, DATES.length);
  assert.equal(r.challenger.outside_gate_cities, DATES.length);
  assert.deepEqual(r.challenger.other_section_rows, { legacy_reference_holdout_cities: 40 });
  // The legacy section's March dates are not the window.
  assert.deepEqual(r.challenger.window, { from: DATES[0], to: DATES[DATES.length - 1] });
  assert.equal(r.pairing.paired, reg.length);
  assert.equal(r.pairing.only_in_registered, 0);
  assert.equal(r.pairing.only_in_challenger, 0);
  assert.equal(r.bootstrap.delta, 0);
  assert.equal(r.verdict, C.VERDICT_STANDS);
});

test('the columns are found by name, so an older rows file (fewer serve columns) reads the same', async () => {
  const rows = population();
  const older = HEADER.slice(0, HEADER.indexOf('served_model_when_fresh'));
  const olderLine = (r) => line(r).split(',').slice(0, older.length).join(',');
  const file = path.join(TMP, 'older.csv');
  fs.writeFileSync(file, [older.join(','), ...rows.map(olderLine)].join('\n') + '\n');
  require('../services/labelQuarantine').writeReplayStamp(file);
  const r = await C.compareFiles(file, write(rows));
  assert.equal(r.pairing.paired, rows.length);
  assert.equal(r.bootstrap.delta, 0);
});

test('a slot held twice refuses: the corpus keeps one live reading per venue, date and hour', async () => {
  const reg = population();
  const twin = { ...reg[0], y: reg[0].y + 30, served: reg[0].y + 30 + HIT };
  const chal = clone(reg);
  chal.unshift({ ...twin });
  const err = await refusal(C.compareFiles(write([...reg, twin]), write(chal)));
  assert.match(err.message, /keys are held more than once/);
  assert.equal(err.result.verdict, C.VERDICT_REFUSED);
  assert.equal(err.result.pairing.keys_held_more_than_once, 1);
});

test('an extra miss in one file\'s duplicate slot can never turn into a CLEARS', async () => {
  // The review's case: each date, one slot is held twice in the registered
  // file only (a miss beside the hit), which positional pairing met with the
  // challenger's hit and read as a gain. Refused, never cleared.
  const reg = population();
  const extra = [...new Set(reg.map((r) => r.date))].map((date) => {
    const r0 = reg.find((r) => r.date === date);
    return { ...r0, y: r0.y - 10, served: r0.y + 20 };
  });
  const err = await refusal(C.compareFiles(write([...reg, ...extra]), write(clone(reg))));
  assert.equal(err.result.verdict, C.VERDICT_REFUSED);
  assert.ok(err.result.pairing.keys_held_more_than_once >= extra.length);
});

// ── Refusals ──────────────────────────────────────────────────────────────────

test('labels that disagree on more than 0.1% of paired rows refuse; at or below it they are counted', async () => {
  const reg = population();
  const many = clone(reg);
  for (let i = 0; i < 12; i++) many[i * 97].y += 1; // 1.0% of 1,200
  const err = await refusal(C.compareFiles(write(reg), write(many)));
  assert.match(err.message, /12 of 1200 paired rows disagree on y/);
  assert.equal(err.result.verdict, C.VERDICT_REFUSED);
  assert.equal(err.result.pairing.y_mismatches, 12);
  assert.equal(err.result.bootstrap, null);

  const one = clone(reg);
  one[5].y += 1; // 0.083%
  const ok = await C.compareFiles(write(reg), write(one));
  assert.equal(ok.pairing.y_mismatches, 1);
  assert.notEqual(ok.verdict, C.VERDICT_REFUSED);
});

test('fewer than 99% of either file\'s population pairing refuses, naming rows that did not pair', async () => {
  const reg = population();
  const chal = clone(reg).filter((_, i) => i % 50 !== 7); // drops 24 rows, 2%
  const err = await refusal(C.compareFiles(write(reg), write(chal)));
  assert.match(err.message, /of the registered file's 1200 gate-population rows pair/);
  assert.match(err.message, /only in registered \(24\)/);
  assert.equal(err.result.pairing.only_in_registered, 24);
  assert.equal(err.result.pairing.examples.only_in_registered.length, 5);
  assert.match(err.result.pairing.examples.only_in_registered[0], /^venue \d+ \(\w+\) 2026-09-\d\d \d\d:00 y=\d+ served=\d+$/);

  // And from the other side: extra readings only the challenger scored.
  const extra = clone(reg).map((r, i) => (i % 40 === 3 ? { ...r, venue_id: `${r.venue_id}9` } : r));
  const err2 = await refusal(C.compareFiles(write(reg), write(extra)));
  assert.match(err2.message, /only in challenger \(30\)/);
});

test('different windows refuse before any row is paired', async () => {
  const reg = population();
  // The challenger's run declared a later from_date: its first date is gone.
  const later = clone(reg).filter((r) => r.date !== DATES[0]);
  const err = await refusal(C.compareFiles(write(reg), write(later)));
  assert.match(err.message, /different windows: registered 2026-09-04 \.\. 2026-09-13, challenger 2026-09-05 \.\. 2026-09-13/);
  assert.equal(err.result.pairing, null);

  // A window that differs only outside the gate's cities still differs.
  const earlier = [...clone(reg), { section: 'live_time_holdout', venue_id: '8001', city: 'miami', date: '2026-09-03', hour: 19, y: 50, ml: 1, served: 50 }];
  const err2 = await refusal(C.compareFiles(write(reg), write(earlier)));
  assert.match(err2.message, /different windows/);
});

test('a file that is not a rows-out file, or has a shifted row, is refused rather than read', async () => {
  const rows = population();
  const noServed = write(rows, { header: HEADER.map((h) => (h === 'served' ? 'served_x' : h)).join(',') });
  assert.match((await refusal(C.compareFiles(noServed, write(rows)))).message, /has no served column/);
  const shifted = write(rows, { extraLines: [line(rows[0]).replace(',bar,bar,', ',bar, lounge,bar,')] });
  assert.match((await refusal(C.compareFiles(shifted, write(rows)))).message, /line 1202 has 39 fields where the header has 38/);
  assert.match((await refusal(C.compareFiles(path.join(TMP, 'missing.csv'), write(rows)))).message, /does not exist/);
  const empty = clone(rows);
  empty[3].served = '';
  assert.match((await refusal(C.compareFiles(write(empty), write(rows)))).message, /1 gate-population row without a usable/);
});

// ── The command line ──────────────────────────────────────────────────────────

test('the CLI prints the verdict and the reminder about (a), writes --out, and exits 1 on a refusal', () => {
  const reg = population();
  const regFile = write(reg);
  const out = path.join(TMP, 'result.json');
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  const better = run(`--registered=${regFile}`, `--challenger=${write(shiftHits(reg, DATES.map(() => 24)))}`, `--out=${out}`);
  assert.equal(better.status, 0, better.stderr);
  assert.match(better.stdout, /^CHALLENGER CLEARS \(b\)$/m);
  assert.match(better.stdout, /\(a\) is judged by the challenger's own gate report/);
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(written.verdict, C.VERDICT_CLEARS);
  assert.equal(written.pairing.paired, reg.length);
  assert.ok(written.bootstrap.ci95[0] > 0);

  const same = run(`--registered=${regFile}`, `--challenger=${write(reg)}`);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /^REGISTERED STANDS on \(b\)$/m);
  assert.match(same.stdout, /\(a\) is judged by the challenger's own gate report/);

  // A refusal exits 1 and overwrites --out, so the earlier verdict cannot be read as this one.
  const refused = run(`--registered=${regFile}`, `--challenger=${write(reg.filter((r) => r.date !== DATES[0]))}`, `--out=${out}`);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /REFUSED: the two runs scored different windows/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).verdict, C.VERDICT_REFUSED);

  const usage = run(`--registered=${regFile}`);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: node compareCandidates\.js/);
});

test('the population, bootstrap defaults and cities are imported from bandEval, not restated', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'train', 'compareCandidates.js'), 'utf8');
  for (const city of B.BAND_GATE_CITIES) assert.doesNotMatch(src, new RegExp(`'${city}'`), city);
  assert.doesNotMatch(src, /20260925/);
  assert.doesNotMatch(src, /resamples:\s*\d/);
  assert.match(src, /require\('\.\/bandEval'\)/);
  assert.ok(src.includes('pairedDateBootstrap(rows, chalHits, regHits)'));
});

test('a rows file scored before the label quarantine, or under another version of it, is refused', async () => {
  // A replay with no stamp beside it was scored before 2026-11-27 and may
  // score readings the provider generated (services/labelQuarantine.js).
  const reg = population();
  const unstamped = write(reg, { stamp: false });
  const stamped = write(clone(reg));
  let err = await refusal(C.compareFiles(unstamped, stamped));
  assert.match(err.message, /scored before the label quarantine/);
  const stale = write(clone(reg));
  fs.writeFileSync(`${stale}.label-trust.json`, JSON.stringify({ quarantine_sha256: '0'.repeat(64) }));
  err = await refusal(C.compareFiles(stamped, stale));
  assert.match(err.message, /another version of labelQuarantine\.json/);
  // A current stamp beside an older replay copied over the one it certified.
  const swapped = write(clone(reg));
  fs.writeFileSync(swapped, fs.readFileSync(unstamped));
  fs.appendFileSync(swapped, '\n');
  err = await refusal(C.compareFiles(stamped, swapped));
  assert.match(err.message, /not the replay its stamp certifies/);
});
