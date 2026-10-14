'use strict';
// ---------------------------------------------------------------------------
// THE NO-CURVE FALLBACK, SCORED ON THE VENUES IT WOULD SERVE (analysis only).
//
// CROWD_NO_CURVE_FALLBACK=category_curve (services/mlPredictor.js) answers a
// venue with no ml_venue_baselines row from the shipped artifact's
// category_baselines table instead of the rule engine, when the venue has 200
// or more Google reviews and its first three Google types name one of the
// table's categories. It shipped off on 2026-10-06, measured on Lehigh and
// Miami over 2026-09-01..08, "until Philadelphia is checked". This is that
// check, plus a re-check of the two measured cities on the dates after that
// study, which no choice in the gate was made on.
//
// HOW A VENUE WITH NO CURVE IS SCORED, when nearly every venue with live
// readings has one: the curve is withheld. Each live reading
// (label_source = 'live') is answered twice, by the two functions production
// calls at the no-baseline exit: crowdEngine.calculateCrowdScore (the rule
// engine) and mlPredictor's noCurveFallbackValue (the table, behind every gate
// that needs no query: the review count, the first three types naming a
// category, a finite cell). A reading the gate refuses is answered by the rule
// engine either way and is left out of the comparison. Neither answer reads
// the venue's curve or any live reading. The venue's own weekly rows are one
// of thousands in the table's training frame (Philadelphia and Lehigh are
// training cities, Miami a holdout city), the caveat the first study carried.
// The handful of live rows whose venue really has no curve in the export are
// reported as their own slice: they are the population the switch serves.
//
// Scored against the live reading on the band ladder the card uses
// (crowdEngine.getLabel). Each difference (table minus rule engine, on the
// same rows) carries a 95% interval from a DATE-BLOCK bootstrap, whole
// observation dates resampled as bandEval.js resamples them, and beside it a
// venue-block and a two-way (dates and venues crossed) interval, because a
// fallback's error is mostly the venue's own departure from its category and
// repeats on every reading of it.
//
// IT NEVER OPENS A DATABASE CONNECTION (bandEval.isolateFromDatabases). It
// reads export-shaped CSVs: the training export, or one city exported by
// export_training_data.js exportCity. A later file's live row replaces an
// earlier file's row for the same venue, date and hour.
//
// Run (from backend/):
//   node scripts/ml/train/noCurveFallbackEval.js \
//     --csv=scripts/ml/train/training_data.csv --csv=scripts/ml/train/holdout_data.csv \
//     [--csv=<a newer city extract>] --cities=philly,lehigh,miami \
//     --from=2026-09-01 [--to=2026-10-14] [--split=2026-09-09] [--out=<report.json>]
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const bandEval = require('./bandEval');

const RESAMPLES = 2000;
const SEED = 20261014;
// The last date the 2026-10-06 study scored. Its gate (200 reviews, the first
// three types) was read off rows up to here, so Lehigh and Miami are out of
// sample for it only from the day after.
const STUDY_THROUGH = '2026-09-08';
const DEFAULT_SPLIT = '2026-09-09';

function parseArgs(argv) {
  const out = { csv: [], cities: ['philly', 'lehigh', 'miami'], from: '2026-09-01', to: '9999-12-31', split: DEFAULT_SPLIT, out: null, models: null };
  for (const a of argv) {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (!m) throw new Error(`unrecognised argument ${a}`);
    const [, k, v] = m;
    if (k === 'csv') out.csv.push(v);
    else if (k === 'cities') out.cities = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (['from', 'to', 'split'].includes(k)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--${k} must be YYYY-MM-DD`);
      out[k] = v;
    } else if (k === 'out' || k === 'models') out[k] = v;
    else throw new Error(`unknown option --${k}`);
  }
  if (!out.csv.length) throw new Error('at least one --csv=<export.csv> is required');
  return out;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const STATS = ['n', 'ae', 'se', 'exact', 'w1b', 'w10', 'bd'];
const zero = () => ({ n: 0, ae: 0, se: 0, exact: 0, w1b: 0, w10: 0, bd: 0 });

function addRow(acc, y, p, cuts) {
  const a = bandEval.bandOf(y, cuts);
  const b = bandEval.bandOf(p, cuts);
  const e = p - y;
  acc.n += 1;
  acc.ae += Math.abs(e);
  acc.se += e;
  acc.exact += a === b ? 1 : 0;
  acc.w1b += Math.abs(a - b) <= 1 ? 1 : 0;
  acc.w10 += Math.abs(e) <= 10 ? 1 : 0;
  acc.bd += Math.abs(a - b);
}

const METRICS = [
  ['mae', (t) => t.ae / t.n],
  ['band_exact', (t) => (t.exact / t.n) * 100],
  ['within_one_band', (t) => (t.w1b / t.n) * 100],
  ['within_10', (t) => (t.w10 / t.n) * 100],
  ['band_mae', (t) => t.bd / t.n],
  ['bias', (t) => t.se / t.n],
];

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

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

// One comparison: the table (A) against the rule engine (B) on the same rows,
// each metric's point values, and A - B with a percentile 95% interval under
// each of the three resampling schemes.
function compare(rows, cuts) {
  const cells = new Map();
  for (const r of rows) {
    const k = `${r.date}|${r.venueId}`;
    if (!cells.has(k)) cells.set(k, { d: r.date, v: r.venueId, a: zero(), b: zero() });
    const c = cells.get(k);
    addRow(c.a, r.y, r.table, cuts);
    addRow(c.b, r.y, r.rule, cuts);
  }
  const list = [...cells.values()];
  const dates = [...new Set(list.map((c) => c.d))].sort();
  const venues = [...new Set(list.map((c) => c.v))];
  const A = zero();
  const B = zero();
  for (const c of list) for (const s of STATS) { A[s] += c.a[s]; B[s] += c.b[s]; }
  const out = { rows: A.n, dates: dates.length, venues: venues.length, first_date: dates[0] || null, last_date: dates[dates.length - 1] || null };
  const intervals = {};
  for (const mode of ['date', 'venue', 'two_way']) {
    const rand = mulberry32(SEED);
    const draws = METRICS.map(() => []);
    for (let s = 0; s < RESAMPLES; s++) {
      const wD = new Map();
      const wV = new Map();
      if (mode !== 'venue') for (let j = 0; j < dates.length; j++) { const d = dates[Math.floor(rand() * dates.length)]; wD.set(d, (wD.get(d) || 0) + 1); }
      if (mode !== 'date') for (let j = 0; j < venues.length; j++) { const v = venues[Math.floor(rand() * venues.length)]; wV.set(v, (wV.get(v) || 0) + 1); }
      const a = zero();
      const b = zero();
      for (const c of list) {
        const w = (mode === 'venue' ? 1 : (wD.get(c.d) || 0)) * (mode === 'date' ? 1 : (wV.get(c.v) || 0));
        if (!w) continue;
        for (const st of STATS) { a[st] += w * c.a[st]; b[st] += w * c.b[st]; }
      }
      if (!a.n) continue;
      METRICS.forEach(([, f], m) => draws[m].push(f(a) - f(b)));
    }
    intervals[mode] = METRICS.map((_, m) => {
      const d = draws[m].sort((x, y) => x - y);
      if (d.length < 20) return null;
      const q = (p) => d[Math.min(d.length - 1, Math.max(0, Math.floor(p * (d.length - 1))))];
      return [r2(q(0.025)), r2(q(0.975))];
    });
  }
  METRICS.forEach(([name, f], m) => {
    out[name] = {
      table: A.n ? r2(f(A)) : null,
      rule_engine: B.n ? r2(f(B)) : null,
      diff: A.n ? r2(f(A) - f(B)) : null,
      ci95_date: intervals.date[m],
      ci95_venue: intervals.venue[m],
      ci95_two_way: intervals.two_way[m],
    };
  });
  return out;
}

// Point values only, for the slices.
function pointsOnly(rows, cuts) {
  const A = zero();
  const B = zero();
  for (const r of rows) { addRow(A, r.y, r.table, cuts); addRow(B, r.y, r.rule, cuts); }
  const out = { rows: A.n, venues: new Set(rows.map((r) => r.venueId)).size };
  for (const [name, f] of METRICS) out[name] = { table: A.n ? r2(f(A)) : null, rule_engine: B.n ? r2(f(B)) : null };
  return out;
}

// THE CRITERION, when the documents set none in advance: the table must beat
// the rule engine on mean absolute error AND on the exact level, each with its
// date-block interval excluding zero.
function verdict(cmp) {
  const maeCi = cmp.mae.ci95_date;
  const exactCi = cmp.band_exact.ci95_date;
  const maeWins = Array.isArray(maeCi) && maeCi[1] < 0;
  const exactWins = Array.isArray(exactCi) && exactCi[0] > 0;
  return { mae_beats_rule_engine: maeWins, exact_beats_rule_engine: exactWins, clears: maeWins && exactWins };
}

const reviewTier = (n) => (n < 500 ? '200-499' : n < 2000 ? '500-1999' : '2000+');
const hourGroup = (h) => (h <= 5 ? '00-05' : h <= 10 ? '06-10' : h <= 14 ? '11-14' : h <= 16 ? '15-16' : h <= 20 ? '17-20' : '21-23');

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  bandEval.pinUtcClock();
  bandEval.isolateFromDatabases();
  const files = args.csv.map((f) => path.resolve(f));
  const t0 = Date.now();
  const corpus = await bandEval.readCorpus(files);
  console.log(`[NoCurve] read ${corpus.census.rows.toLocaleString()} rows (${corpus.live.length.toLocaleString()} live) from ${files.length} file(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const art = await bandEval.loadArtifact(args.models ? path.resolve(args.models) : path.resolve(__dirname, '..', 'models'));
  const { I } = art;
  if (art.meta.model_version !== I.NO_CURVE_FALLBACK_FITTED_ON) {
    throw new Error(`the loaded artifact is ${art.meta.model_version}; the switch serves the table only beside ${I.NO_CURVE_FALLBACK_FITTED_ON}, so this would score a table production never shows.`);
  }
  const crowdEngine = require('../../../services/crowdEngine');
  const { cuts, labels } = bandEval.bandLadder(crowdEngine.getLabel);

  // A later file's reading replaces an earlier one's for the same slot.
  const latest = new Map();
  for (const r of corpus.live) latest.set(`${r.venueId}|${r.date}|${r.hour}`, r);
  const cities = new Set(args.cities);
  const scored = [];
  let skipped = 0;
  let gateRefused = 0;
  const seenVenues = new Map();
  for (const r of latest.values()) {
    if (!cities.has(r.city) || r.date < args.from || r.date > args.to) continue;
    if (!Number.isFinite(r.y) || !(r.hour >= 0 && r.hour <= 23)) { skipped++; continue; }
    const ts = bandEval.wallClock(r.date, r.hour);
    // prepareRows' rule: a date and a weekday that disagree are not one clock.
    if (ts.getDay() !== r.dow) { skipped++; continue; }
    // The venue exactly as prepareRows builds it for the replay.
    const venue = {
      place_id: `nocurve-${r.venueId}`,
      types: r.types,
      rating: r.rating || null,
      user_ratings_total: r.reviewCount || 0,
      price_level: r.priceLevel,
      location: Number.isFinite(r.lat) && Number.isFinite(r.lng) ? { latitude: r.lat, longitude: r.lng } : null,
    };
    const table = I.noCurveFallbackValue(venue, ts);
    if (!seenVenues.has(r.venueId)) seenVenues.set(r.venueId, { city: r.city, served: table !== null });
    if (table === null) { gateRefused++; continue; }
    const rule = crowdEngine.calculateCrowdScore(venue, r.weather, ts).score;
    scored.push({
      venueId: r.venueId,
      city: r.city,
      date: r.date,
      hour: r.hour,
      y: r.y,
      table,
      rule,
      reviews: r.reviewCount || 0,
      category: I.noCurveFallbackCategory(r.types.slice(0, I.NO_CURVE_FALLBACK_TYPES_READ)),
      hasCurve: corpus.curves.has(r.venueId),
    });
  }
  console.log(`[NoCurve] ${scored.length.toLocaleString()} readings the gate serves the table for; ${gateRefused.toLocaleString()} it hands to the rule engine either way; ${skipped} skipped (date and weekday disagree)`);

  const report = {
    generated_at: new Date().toISOString(),
    artifact: art.meta.model_version,
    files: corpus.census.files,
    window: { from: args.from, to: args.to, split: args.split, study_through: STUDY_THROUGH },
    cuts,
    labels,
    resamples: RESAMPLES,
    criterion: 'table beats the rule engine on MAE and on the exact level, each with its date-block 95% interval excluding zero',
    gate_coverage: {},
    cities: {},
  };
  for (const city of args.cities) {
    const vs = [...seenVenues.values()].filter((v) => v.city === city);
    report.gate_coverage[city] = { venues_with_live_rows: vs.length, venues_the_gate_serves: vs.filter((v) => v.served).length };
  }

  const windows = (city) => (city === 'lehigh' || city === 'miami'
    ? { all: () => true, after_study: (r) => r.date >= args.split }
    : { all: () => true });
  for (const city of [...args.cities, 'pooled']) {
    const inCity = scored.filter((r) => city === 'pooled' || r.city === city);
    if (!inCity.length) continue;
    report.cities[city] = {};
    const wins = city === 'pooled' ? { all: () => true, out_of_study: (r) => r.city === 'philly' || r.date >= args.split } : windows(city);
    for (const [win, keep] of Object.entries(wins)) {
      const rows = inCity.filter(keep);
      if (!rows.length) continue;
      const cmp = compare(rows, cuts);
      const slices = {};
      const by = (name, key) => {
        const groups = new Map();
        for (const r of rows) { const g = key(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
        slices[name] = Object.fromEntries([...groups.keys()].sort().map((g) => [g, pointsOnly(groups.get(g), cuts)]));
      };
      by('review_tier', (r) => reviewTier(r.reviews));
      by('category', (r) => r.category);
      by('hour_group', (r) => hourGroup(r.hour));
      by('venue_has_curve', (r) => (r.hasCurve ? 'curve_withheld' : 'no_curve_in_export'));
      report.cities[city][win] = { ...cmp, verdict: verdict(cmp), slices };
      const v = report.cities[city][win];
      const line = (k) => `${k.padEnd(16)} table ${String(v[k].table).padStart(6)}  rule ${String(v[k].rule_engine).padStart(6)}  diff ${String(v[k].diff).padStart(6)}  date ${JSON.stringify(v[k].ci95_date)}  venue ${JSON.stringify(v[k].ci95_venue)}  both ${JSON.stringify(v[k].ci95_two_way)}`;
      console.log(`\n-- ${city} / ${win}: ${v.rows.toLocaleString()} readings, ${v.venues} venues, ${v.dates} dates (${v.first_date}..${v.last_date})`);
      for (const [k] of METRICS) console.log(`   ${line(k)}`);
      console.log(`   verdict: ${JSON.stringify(v.verdict)}`);
    }
  }

  const outFile = args.out ? path.resolve(args.out) : path.join(__dirname, 'no_curve_fallback_out', 'no_curve_fallback_report.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n[NoCurve] report -> ${outFile}`);
  return report;
}

module.exports = { main, compare, verdict, parseArgs };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
