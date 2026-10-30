'use strict';
// ---------------------------------------------------------------------------
// FILL CITIES (2026-10-30). The six-city main scope finishes well inside the
// hourly sweep's fifty minutes at the faster pace (17 minutes at 4 AM Eastern,
// most of its venues shut), so most of the hour went unused. --fill-cities
// names cities swept after the main scope in the time it leaves. Pinned here:
//   * the flag is checked and refused when it cannot mean what it says;
//   * fill blocks always come after every main block, so the budget reaches
//     them first, and they start from a different city each hour;
//   * on a simulated clock, a fill that cannot fit never costs a main venue
//     its call, fill calls stop FILL_EARLY_STOP_MS before the budget, and a
//     fill block reached after that is skipped without a weather call;
//   * run() is wired to all of it.
//
// HOW TO RUN
//   cd backend && node --test __tests__/collectRealtimeFillCities.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// NOTHING HERE MAY REACH A REAL SERVICE, for the reasons
// collectRealtimeConcurrency.test.js gives: a database URL on a port nothing
// listens on, an empty BestTime key, and the three services replaced outright.
process.env.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:1/none';
process.env.PGSSLMODE = 'disable';
process.env.BESTTIME_API_KEY = '';

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}
const realBestTime = require('../scripts/ml/bestTimeService');
stubModule('../scripts/ml/bestTimeService', {
  ...realBestTime,
  fetchLiveBusyness: async () => { throw new Error('this suite must inject fetchLive'); },
  fetchWeeklyForecast: async () => { throw new Error('the realtime collector never fetches a week'); },
});
stubModule('../services/weatherService', {
  getWeather: async () => { throw new Error('this suite must inject weatherFor'); },
  getForecast: async () => [],
});
stubModule('../scripts/ml/eventService', {
  getNearestEvent: async () => { throw new Error('storeReading is not under test here'); },
});

const {
  sweepVenues, parseFillCities, orderCityBlocks, FILL_EARLY_STOP_MS, LABEL_LIVE,
} = require('../scripts/ml/collectRealtime');
const { virtualClock } = require('./helpers/virtualClock');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const BUDGET_MS = 50 * MINUTE; // collectRealtime's RUN_TIME_BUDGET_MS, pinned in collectRealtimeBudget.test.js
const START = Date.UTC(2026, 8, 25, 23, 0, 0);
const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'collectRealtime.js'), 'utf8');

const MAIN = ['philly', 'lehigh'];

// ===========================================================================
// 1. The flag
// ===========================================================================

test('no flag: no fill, and the line says the flag never arrived', () => {
  const r = parseFillCities(['node', 'collectRealtime.js'], { cityScope: MAIN, allCities: false });
  assert.deepStrictEqual(r.fillCities, []);
  assert.strictEqual(r.refusal, null);
  assert.match(r.note, /no --fill-cities flag reached this process/);
});

test('a name that is not a city is refused, by name', () => {
  const r = parseFillCities(['--fill-cities=seoul,sole,londn'], { cityScope: MAIN, allCities: false });
  assert.deepStrictEqual(r.fillCities, []);
  assert.match(r.refusal, /names sole, londn, not cities in scripts\/ml\/config\.js/);
});

test('beside --all-cities the flag is refused: every city is already in scope', () => {
  const r = parseFillCities(['--fill-cities=seoul'], { cityScope: null, allCities: true });
  assert.match(r.refusal, /cannot be combined with --all-cities/);
});

test('the holdout city is refused, and a holdout hour runs the holdout city alone', () => {
  const holdout = { city: 'miami', active: false };
  const refused = parseFillCities(['--fill-cities=seoul,miami'], { cityScope: MAIN, allCities: false, holdout });
  assert.match(refused.refusal, /includes the holdout city miami/);
  const hour = parseFillCities(['--fill-cities=seoul'], {
    cityScope: ['miami'], allCities: false, holdout: { city: 'miami', active: true },
  });
  assert.deepStrictEqual(hour.fillCities, []);
  assert.strictEqual(hour.refusal, null);
  assert.match(hour.note, /holdout hour/);
});

test('repeats and cities already in the main scope are dropped, in the order given', () => {
  const r = parseFillCities(['--fill-cities= seoul,philly,seoul,london ,'], { cityScope: MAIN, allCities: false });
  assert.deepStrictEqual(r.fillCities, ['seoul', 'london']);
  assert.strictEqual(r.refusal, null);
  const all = parseFillCities(['--fill-cities=philly'], { cityScope: MAIN, allCities: false });
  assert.deepStrictEqual(all.fillCities, []);
  assert.match(all.note, /already in the main scope/);
});

// ===========================================================================
// 2. The order
// ===========================================================================

const byCityOf = (keys) => Object.fromEntries(keys.map((k) => [k, [{ id: k }]]));
const keysOf = (order) => order.map(([k]) => k);

test('fill blocks come after every main block, whichever way the main scope runs', () => {
  const byCity = byCityOf(['bangkok', 'chicago', 'london', 'philly', 'seoul']);
  const fill = ['bangkok', 'london', 'seoul'];
  // 0.9: the main scope keeps its order; the fill starts at floor(0.9 * 3) = 2.
  assert.deepStrictEqual(keysOf(orderCityBlocks(byCity, fill, () => 0.9)),
    ['chicago', 'philly', 'seoul', 'bangkok', 'london']);
  // 0.1: the main scope is reversed; the fill starts at its first city.
  assert.deepStrictEqual(keysOf(orderCityBlocks(byCity, fill, () => 0.1)),
    ['philly', 'chicago', 'bangkok', 'london', 'seoul']);
  for (let i = 0; i < 50; i++) {
    const r = (i * 37 % 100) / 100;
    const order = keysOf(orderCityBlocks(byCity, fill, () => r));
    const lastMain = Math.max(order.indexOf('chicago'), order.indexOf('philly'));
    assert.ok(fill.every((c) => order.indexOf(c) > lastMain), `a fill city before a main one: ${order}`);
    assert.strictEqual(order.length, 5);
  }
});

test('without fill cities the order is the old one: the query order, or its reverse', () => {
  const byCity = byCityOf(['chicago', 'denver', 'philly']);
  assert.deepStrictEqual(keysOf(orderCityBlocks(byCity, [], () => 0.9)), ['chicago', 'denver', 'philly']);
  assert.deepStrictEqual(keysOf(orderCityBlocks(byCity, [], () => 0.1)), ['philly', 'denver', 'chicago']);
});

// ===========================================================================
// 3. The sweep, on a simulated clock
// ===========================================================================

function venuesFor(city, n, firstId) {
  return Array.from({ length: n }, (_, i) => ({
    id: firstId + i, besttime_venue_id: `bt_${city}_${firstId + i}`, name: `${city} venue ${firstId + i}`,
    city, timezone: 'America/New_York',
  }));
}

async function sweepWithFill(cityOrder, fillCities) {
  const clock = virtualClock(START);
  const calls = [];
  const weatherCalls = [];
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved)) console[level] = (...a) => lines.push({ level, at: clock.now(), text: a.join(' ') });
  try {
    const result = await clock.run(sweepVenues(cityOrder, {
      // A five second pace keeps the simulation small; the budget arithmetic
      // is the same at any pace.
      startIntervalMs: 5 * SECOND,
      fillCities: new Set(fillCities),
      fetchLive: async (vendorId) => {
        calls.push({ vendorId, startAt: clock.now() });
        await clock.pause(1000);
        return { forecastedBusyness: 40, liveBusyness: 70, liveAvailable: true, hour: null, venueOpen: true };
      },
      store: async () => { await clock.pause(30); return LABEL_LIVE; },
      weatherFor: async (lat, lon) => { weatherCalls.push({ lat, lon }); return { lat, lon }; },
      now: clock.now,
      pause: clock.pause,
    }));
    return { result, calls, weatherCalls, lines };
  } finally {
    Object.assign(console, saved);
  }
}

test('a fill that cannot fit never costs a main venue its call, and stops six minutes early', async () => {
  // 100 main venues take about 8 minutes at one start per five seconds; the
  // 1,000 London venues could not finish in an hour, and Paris comes after.
  const main = venuesFor('philly', 100, 1);
  const london = venuesFor('london', 1000, 1001);
  const paris = venuesFor('paris', 50, 3001);
  const { result, calls, weatherCalls, lines } = await sweepWithFill(
    [['philly', main], ['london', london], ['paris', paris]], ['london', 'paris']);

  const calledIds = new Set(calls.map((c) => c.vendorId));
  assert.ok(main.every((v) => calledIds.has(v.besttime_venue_id)), 'a main venue went uncalled');
  assert.ok(!paris.some((v) => calledIds.has(v.besttime_venue_id)), 'a fill block after the fill time was called');
  const lastStart = Math.max(...calls.map((c) => c.startAt));
  assert.ok(lastStart - START <= BUDGET_MS - FILL_EARLY_STOP_MS, `a fill call started ${(lastStart - START) / MINUTE} min in`);
  assert.ok(lastStart - START > BUDGET_MS - FILL_EARLY_STOP_MS - MINUTE, 'the fill stopped well before its time');
  assert.strictEqual(FILL_EARLY_STOP_MS, 6 * MINUTE);

  assert.strictEqual(result.budgetHit, true);
  assert.strictEqual(result.called, calls.length);
  assert.strictEqual(result.leftForNextRun, main.length + london.length + paris.length - result.called);
  const fillLines = lines.filter((l) => /Fill time reached/.test(l.text));
  assert.strictEqual(fillLines.length, 1);
  assert.strictEqual(fillLines[0].text, `[ML:Realtime] Fill time reached after ${result.called} calls (fill cities stop `
    + '6 minutes before the budget); the rest of the fill is left for the next run.');
  assert.ok(!lines.some((l) => /Time budget reached/.test(l.text)), 'the main budget line printed for a fill stop');
  // Philadelphia and London asked for their weather; Paris, never reached, did not.
  assert.strictEqual(weatherCalls.length, 2);
  assert.ok(!lines.some((l) => /\[ML:Realtime\] Paris \(/.test(l.text)), 'the skipped block printed a header');
});

test('a fill that fits is swept whole, and nothing is left over', async () => {
  const main = venuesFor('philly', 60, 1);
  const seoul = venuesFor('seoul', 60, 1001);
  const { result, calls } = await sweepWithFill([['philly', main], ['seoul', seoul]], ['seoul']);
  assert.strictEqual(result.budgetHit, false);
  assert.strictEqual(result.leftForNextRun, 0);
  assert.strictEqual(calls.length, 120);
  // In order: every main call started before the first fill call.
  const firstFill = calls.findIndex((c) => c.vendorId.startsWith('bt_seoul_'));
  assert.strictEqual(firstFill, 60);
});

// ===========================================================================
// 4. run() is wired to it
// ===========================================================================

test('run() parses the flag, reads the fill with the main scope, orders it last and tallies by city', () => {
  const src = SRC.replace(/\r\n/g, '\n');
  assert.match(src, /const fill = parseFillCities\(process\.argv, \{ cityScope, allCities, holdout: HOLDOUT \}\);/);
  assert.match(src, /if \(fill\.refusal\) \{\n {4}await pool\.end\(\);\n {4}throw new Error\(`REFUSED: \$\{fill\.refusal\}/);
  assert.match(src, /const queryScope = cityScope \? cityScope\.concat\(fillCities\) : null;/);
  assert.match(src, /queryScope \? \[queryScope\] : \[\]/);
  assert.match(src, /openHourMasks = await loadOpenHourMasks\(queryScope\);/);
  assert.match(src, /const cityOrder = orderCityBlocks\(byCity, fillCities\);/);
  assert.match(src, /fillCities: fillSet,\n {2}\}\);/);
  // The main scope must hold venues on its own: a run of fill cities alone is
  // not the run that was asked for.
  assert.match(src, /if \(mainVenues\.length === 0\) \{/);
  assert.match(src, /Fill cities: \$\{fillCities\.length/);
  assert.match(src, /Live rows \/ calls by city: /);
});
