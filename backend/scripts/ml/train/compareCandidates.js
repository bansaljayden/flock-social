'use strict';
// ---------------------------------------------------------------------------
// TWO CANDIDATES, ONE DATABASE MOMENT: RULE (b) OF THE HARVEST-INCLUSIVE RUN.
//
// The November retrain trains two candidates on two exports of the same
// database moment: the registered one (the default export, harvested venues
// left out) and a harvest-inclusive one (export_training_data.js
// --include-harvested). Written before either was trained, the harvest-inclusive
// candidate replaces the registered one only if
//
//   (a) it passes all eight band-gate criteria on its own: its own
//       `bandEval.js --gate` run, read off ship_gate.band_gate in its
//       model_metadata.json. This file does not judge (a).
//   (b) its within-10 (|served - y| <= 10) on the gate's live readings is
//       higher than the registered candidate's, with the lower bound of the
//       95% date-paired bootstrap interval above zero, on the same rows.
//
// One bandEval run cannot score both: each candidate is scored on its OWN
// export, whose neighbour features differ. So each candidate's gate run writes
// --rows-out=<csv>, and this file pairs the two files' rows and runs the
// gate's own bootstrap (bandEval.pairedDateBootstrap, its default resamples
// and seed) on them.
//
// THE POPULATION is the gate's: section live_time_holdout (the window each run
// read from its candidate's time_holdout.from_date), ml = 1 (the model path;
// scoreArtifact sets it only where the served baseline is positive, so it is
// the gate's `smoothed > 0 && ml`), city in bandEval.BAND_GATE_CITIES. Rows are
// paired by (venue_id, date, hour). The labels are the same live readings in
// both exports, so the comparison is refused when the windows differ, when
// the populations do not pair, or when paired rows disagree on y.
//
// Reads only the columns it needs, one line at a time (a rows file runs past
// 100 MB). Never opens a database or the network.
//
// Run (from backend/scripts/ml/train):
//   node compareCandidates.js --registered=<rows-out csv> --challenger=<rows-out csv> [--out=<json>]
// Exit 0 with a verdict line; exit 1 when the comparison is refused or the
// arguments are wrong.
// ---------------------------------------------------------------------------

const fs = require('fs');
const readline = require('readline');
const { parseCsvLine, pairedDateBootstrap, BAND_GATE, BAND_GATE_CITIES } = require('./bandEval');

// bandEval main()'s label for the time-holdout section of a rows file; the
// other section (--legacy) is never a gate input.
const GATE_SECTION = 'live_time_holdout';

// The only columns read. A rows file without one of them is refused by name.
const NEEDED_COLUMNS = ['section', 'venue_id', 'city', 'date', 'hour', 'y', 'ml', 'served'];

// Within 10, as bandGate's w10hits counts it.
const WITHIN = 10;

// THE REFUSAL THRESHOLDS. Both files hold the same live readings taken in the
// same window, so on a clean pair of runs each number below is exactly zero;
// the slack is for a reading the database recorded between the two exports,
// not for a different population.
//   * More than 0.1% of paired rows with different labels means the rows are
//     not the same readings, and a within-10 difference on them would partly
//     be a difference in what was scored against.
//   * Fewer than 99% of either file's population pairing means the two runs
//     scored different readings (a different window, city set or export), and
//     a paired interval on the overlap would not be the gate's population.
const MAX_Y_MISMATCH_SHARE = 0.001;
const MIN_PAIRED_SHARE = 0.99;

// Unpaired or mismatched rows named in a refusal, per side.
const EXAMPLES = 5;

const VERDICT_CLEARS = 'CHALLENGER CLEARS (b)';
const VERDICT_STANDS = 'REGISTERED STANDS on (b)';
const VERDICT_REFUSED = 'REFUSED';
const NOTE_A = '(a) is judged by the challenger\'s own gate report (ship_gate.band_gate in its model_metadata.json, '
  + 'from its own bandEval.js --gate run): all eight criteria must pass there, whatever (b) says here.';

class Refusal extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'Refusal';
    this.result = result || null;
  }
}

const pct = (k, n) => (n ? Math.round((k / n) * 1000) / 10 : null);
const share = (k, n) => (n ? Math.round((k / n) * 1e6) / 1e6 : null);
const keyOf = (r) => `${r.venueId}|${r.date}|${r.hour}`;
const describe = (r) => `venue ${r.venueId} (${r.city}) ${r.date} ${String(r.hour).padStart(2, '0')}:00 y=${r.y} served=${r.served}`;

function extendRange(range, date) {
  if (range.from === null || date < range.from) range.from = date;
  if (range.to === null || date > range.to) range.to = date;
}

// One rows file, streamed: the gate population, plus the counts of what was
// left out and the window the run scored (every live_time_holdout row's date,
// whatever its city or path, since that is the window bandEval read).
async function readPopulation(file) {
  if (!file) throw new Refusal('no file given');
  if (!fs.existsSync(file)) throw new Refusal(`${file} does not exist`);
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let ix = null;
  let lineNo = 0;
  const census = {
    file,
    lines: 0,
    other_section_rows: {},
    section_rows: 0,
    not_model_path: 0,
    outside_gate_cities: 0,
    population: 0,
  };
  const window = { from: null, to: null };
  const populationDates = { from: null, to: null };
  const rows = [];
  const bad = [];
  let badCount = 0;
  try {
    for await (const raw of rl) {
      lineNo++;
      const line = lineNo === 1 ? raw.replace(/^\uFEFF/, '') : raw;
      if (header === null) {
        header = parseCsvLine(line);
        const missing = NEEDED_COLUMNS.filter((c) => !header.includes(c));
        if (missing.length) {
          throw new Refusal(`${file} has no ${missing.join(', ')} column${missing.length === 1 ? '' : 's'}: `
            + 'not a bandEval.js --rows-out file');
        }
        ix = Object.fromEntries(NEEDED_COLUMNS.map((c) => [c, header.indexOf(c)]));
        continue;
      }
      if (line === '') continue;
      census.lines++;
      const f = parseCsvLine(line);
      if (f.length !== header.length) {
        throw new Refusal(`${file} line ${lineNo} has ${f.length} fields where the header has ${header.length}; `
          + 'refusing to read shifted columns');
      }
      const section = f[ix.section];
      if (section !== GATE_SECTION) {
        census.other_section_rows[section] = (census.other_section_rows[section] || 0) + 1;
        continue;
      }
      census.section_rows++;
      const date = f[ix.date];
      extendRange(window, date);
      if (f[ix.ml] !== '1') { census.not_model_path++; continue; }
      const city = f[ix.city];
      if (!BAND_GATE_CITIES.includes(city)) { census.outside_gate_cities++; continue; }
      const r = {
        venueId: f[ix.venue_id],
        city,
        date,
        hour: f[ix.hour] === '' ? NaN : Number(f[ix.hour]),
        y: f[ix.y] === '' ? NaN : Number(f[ix.y]),
        served: f[ix.served] === '' ? NaN : Number(f[ix.served]),
      };
      if (!r.venueId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(r.hour)
          || !Number.isFinite(r.y) || !Number.isFinite(r.served)) {
        // Only the needed fields are ever echoed.
        if (bad.length < EXAMPLES) {
          bad.push(`line ${lineNo}: venue_id=${f[ix.venue_id]} date=${date} hour=${f[ix.hour]} y=${f[ix.y]} served=${f[ix.served]}`);
        }
        badCount++;
        continue;
      }
      census.population++;
      extendRange(populationDates, date);
      rows.push(r);
    }
  } finally {
    rl.close();
    input.destroy();
  }
  if (header === null) throw new Refusal(`${file} is empty`);
  if (badCount) {
    throw new Refusal(`${file}: ${badCount} gate-population row${badCount === 1 ? '' : 's'} without a usable venue, date, `
      + `hour, y or served (the model path always has one), e.g.\n    ${bad.join('\n    ')}`);
  }
  return { census, window, populationDates, rows };
}

// Pair by (venue_id, date, hour). A key held twice in a file (one slot, two
// readings) pairs its rows in label order, so equal readings meet each other.
function pairRows(reg, chal) {
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    for (const list of m.values()) if (list.length > 1) list.sort((a, b) => a.y - b.y || a.served - b.served);
    return m;
  };
  const byReg = group(reg);
  const byChal = group(chal);
  const paired = [];
  const onlyReg = [];
  const onlyChal = [];
  let duplicateKeys = 0;
  for (const [k, rList] of byReg) {
    const cList = byChal.get(k) || [];
    if (rList.length > 1 || cList.length > 1) duplicateKeys++;
    const n = Math.min(rList.length, cList.length);
    for (let i = 0; i < n; i++) paired.push({ registered: rList[i], challenger: cList[i] });
    for (let i = n; i < rList.length; i++) onlyReg.push(rList[i]);
    for (let i = n; i < cList.length; i++) onlyChal.push(cList[i]);
  }
  for (const [k, cList] of byChal) {
    if (byReg.has(k)) continue;
    if (cList.length > 1) duplicateKeys++;
    onlyChal.push(...cList);
  }
  return { paired, onlyReg, onlyChal, duplicateKeys };
}

async function compareFiles(registeredFile, challengerFile) {
  const reg = await readPopulation(registeredFile);
  const chal = await readPopulation(challengerFile);
  const side = (s) => ({ ...s.census, window: s.window, population_dates: s.populationDates });
  const result = {
    generated_at: new Date().toISOString(),
    rule: 'harvest-inclusive candidate replaces the registered one only if (a) it passes all eight gate criteria in its own '
      + 'gate run and (b) its within-10 on the gate\'s live readings beats the registered candidate\'s, delta > 0 with the '
      + '95% date-paired bootstrap lower bound > 0',
    population: {
      section: GATE_SECTION,
      model_path: 'ml = 1',
      cities: [...BAND_GATE_CITIES],
      pair_key: ['venue_id', 'date', 'hour'],
      hit: `|served - y| <= ${WITHIN}`,
    },
    thresholds: { max_y_mismatch_share: MAX_Y_MISMATCH_SHARE, min_paired_share: MIN_PAIRED_SHARE },
    registered: side(reg),
    challenger: side(chal),
    pairing: null,
    within_10: null,
    bootstrap: null,
    verdict: VERDICT_REFUSED,
    clears_b: false,
    refused: null,
    note_a: NOTE_A,
  };
  const refuse = (problems) => {
    result.refused = problems;
    throw new Refusal(problems.join('\n'), result);
  };

  // Different windows are different populations before a row is paired.
  if (reg.window.from !== chal.window.from || reg.window.to !== chal.window.to) {
    refuse([`the two runs scored different windows: registered ${reg.window.from} .. ${reg.window.to}, `
      + `challenger ${chal.window.from} .. ${chal.window.to} (each run reads its window from its candidate's `
      + 'time_holdout.from_date; two exports of one database moment declare the same one)']);
  }
  if (!reg.rows.length || !chal.rows.length) {
    refuse([`an empty gate population: registered ${reg.rows.length} rows, challenger ${chal.rows.length} rows `
      + `(${GATE_SECTION}, ml = 1, ${BAND_GATE_CITIES.join('/')})`]);
  }

  const { paired, onlyReg, onlyChal, duplicateKeys } = pairRows(reg.rows, chal.rows);
  const yMismatch = paired.filter((p) => p.registered.y !== p.challenger.y);
  result.pairing = {
    registered_rows: reg.rows.length,
    challenger_rows: chal.rows.length,
    paired: paired.length,
    only_in_registered: onlyReg.length,
    only_in_challenger: onlyChal.length,
    paired_share_of_registered: share(paired.length, reg.rows.length),
    paired_share_of_challenger: share(paired.length, chal.rows.length),
    y_mismatches: yMismatch.length,
    y_mismatch_share: share(yMismatch.length, paired.length),
    keys_held_more_than_once: duplicateKeys,
    examples: {
      only_in_registered: onlyReg.slice(0, EXAMPLES).map(describe),
      only_in_challenger: onlyChal.slice(0, EXAMPLES).map(describe),
      y_mismatches: yMismatch.slice(0, EXAMPLES).map((p) => `${describe(p.registered)} | challenger y=${p.challenger.y}`),
    },
  };

  const problems = [];
  // One live reading per venue, local date and hour is what the corpus holds
  // (migration 024's realtime key drops a second read in the same hour), so a
  // key held twice means the two files are not the gate's rows. Pairing such
  // a slot in any order can meet the wrong readings and print a verdict the
  // data does not support, so it is refused rather than guessed at.
  if (duplicateKeys > 0) {
    problems.push(`${duplicateKeys} (venue, date, hour) keys are held more than once across the two files; `
      + 'the corpus keeps one live reading per slot, so these are not the gate\'s rows.');
  }
  for (const [name, n] of [['registered', reg.rows.length], ['challenger', chal.rows.length]]) {
    if (paired.length / n < MIN_PAIRED_SHARE) {
      problems.push(`only ${paired.length} of the ${name} file's ${n} gate-population rows pair `
        + `(${pct(paired.length, n)}%, need >= ${MIN_PAIRED_SHARE * 100}%): the two runs did not score the same readings.`);
    }
  }
  if (problems.length) {
    const ex = result.pairing.examples;
    if (ex.only_in_registered.length) problems.push(`  only in registered (${onlyReg.length}), e.g.\n    ${ex.only_in_registered.join('\n    ')}`);
    if (ex.only_in_challenger.length) problems.push(`  only in challenger (${onlyChal.length}), e.g.\n    ${ex.only_in_challenger.join('\n    ')}`);
  }
  if (paired.length && yMismatch.length / paired.length > MAX_Y_MISMATCH_SHARE) {
    problems.push(`${yMismatch.length} of ${paired.length} paired rows disagree on y (${pct(yMismatch.length, paired.length)}%, `
      + `allowed <= ${MAX_Y_MISMATCH_SHARE * 100}%): the labels are not the same live readings, e.g.\n    `
      + result.pairing.examples.y_mismatches.join('\n    '));
  }
  if (problems.length) refuse(problems);

  // Each candidate's hit is the one its own gate run counted: its served
  // against its own file's y (the two agree on all but at most 0.1% of rows).
  const rows = paired.map((p) => ({ date: p.registered.date }));
  const hit = (r) => Math.abs(r.served - r.y) <= WITHIN;
  const regHits = paired.map((p) => hit(p.registered));
  const chalHits = paired.map((p) => hit(p.challenger));
  const count = (h) => h.reduce((s, x) => s + (x ? 1 : 0), 0);
  result.within_10 = {
    registered: pct(count(regHits), paired.length),
    challenger: pct(count(chalHits), paired.length),
    registered_hits: count(regHits),
    challenger_hits: count(chalHits),
    n: paired.length,
  };
  // The gate's bootstrap with the gate's defaults (BAND_GATE.bootstrapResamples
  // and pairedDateBootstrap's own seed): challenger minus registered, in points.
  // The pairs are in the registered file's row order, so the date blocks enter
  // the seeded draw in the order the registered gate run's own bootstrap used.
  const boot = pairedDateBootstrap(rows, chalHits, regHits);
  result.bootstrap = {
    metric: 'within_10',
    direction: 'challenger minus registered, percentage points',
    delta: boot.delta,
    ci95: boot.ci95,
    n: paired.length,
    dates: boot.dates,
    resamples: BAND_GATE.bootstrapResamples,
    seed: 'pairedDateBootstrap default (the gate\'s)',
  };
  result.clears_b = boot.delta > 0 && Array.isArray(boot.ci95) && boot.ci95[0] > 0;
  result.verdict = result.clears_b ? VERDICT_CLEARS : VERDICT_STANDS;
  return result;
}

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--(registered|challenger|out)=(.+)$/.exec(a);
    if (!m) throw new Refusal(`unrecognised argument ${a}`);
    args[m[1]] = m[2];
  }
  if (!args.registered || !args.challenger) {
    throw new Refusal('usage: node compareCandidates.js --registered=<rows-out csv> --challenger=<rows-out csv> [--out=<json>]');
  }
  return args;
}

function printResult(r, log = console.log) {
  for (const name of ['registered', 'challenger']) {
    const s = r[name];
    log(`[Compare] ${name}: ${s.file}`);
    log(`  ${s.section_rows} ${GATE_SECTION} rows, window ${s.window.from} .. ${s.window.to}; gate population ${s.population} `
      + `(left out: ${s.not_model_path} rule-engine rows, ${s.outside_gate_cities} outside the six cities, `
      + `${Object.values(s.other_section_rows).reduce((a, b) => a + b, 0)} in other sections)`);
  }
  const p = r.pairing;
  if (p) {
    log(`[Compare] paired ${p.paired}; only in registered ${p.only_in_registered}; only in challenger ${p.only_in_challenger}; `
      + `y disagrees on ${p.y_mismatches} paired rows; keys held more than once ${p.keys_held_more_than_once}`);
  }
  if (r.within_10) {
    log(`[Compare] within 10 on the paired rows: registered ${r.within_10.registered}%, challenger ${r.within_10.challenger}%`);
  }
  if (r.bootstrap) {
    const b = r.bootstrap;
    log(`[Compare] challenger minus registered: delta ${b.delta}pp CI95 ${JSON.stringify(b.ci95)} `
      + `(n ${b.n} rows, ${b.dates} date blocks, ${b.resamples} resamples, the gate's seed)`);
  }
  log(r.verdict === VERDICT_REFUSED ? `${VERDICT_REFUSED}: no verdict on (b)` : r.verdict);
  log(NOTE_A);
}

async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  let args = null;
  try {
    args = parseArgs(argv);
    const result = await compareFiles(args.registered, args.challenger);
    printResult(result, log);
    if (args.out) {
      fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
      log(`[Compare] result -> ${args.out}`);
    }
    return { code: 0, result };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    if (!args) {
      error(`[Compare] ${err.message}`);
      return { code: 1, result: null };
    }
    if (err.result) printResult(err.result, log);
    error(`[Compare] REFUSED: ${err.message}`);
    // A refusal overwrites --out too, so an earlier verdict is never left
    // standing beside a comparison that did not run.
    if (args.out) {
      fs.writeFileSync(args.out, `${JSON.stringify(err.result || { verdict: VERDICT_REFUSED, refused: [err.message], note_a: NOTE_A }, null, 2)}\n`);
    }
    return { code: 1, result: err.result };
  }
}

module.exports = {
  readPopulation,
  pairRows,
  compareFiles,
  parseArgs,
  main,
  Refusal,
  GATE_SECTION,
  NEEDED_COLUMNS,
  WITHIN,
  MAX_Y_MISMATCH_SHARE,
  MIN_PAIRED_SHARE,
  VERDICT_CLEARS,
  VERDICT_STANDS,
  VERDICT_REFUSED,
};

if (require.main === module) {
  main().then(({ code }) => { process.exitCode = code; }).catch((err) => {
    console.error(`[Compare] ${err.message}`);
    process.exitCode = 1;
  });
}
