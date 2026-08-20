// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE RESERVE THAT EXISTED ON ONE LEDGER AND NOT ON THE OTHER TWO
// (money audit round 4)
// ---------------------------------------------------------------------------
// utils/placesBudget.js carries UNAUTH_DAILY, and __tests__/unauthPlacesReserve
// .test.js pins it: whatever the public doors do, the signed-in product keeps
// 1200 of the 3000 paid Places calls a day. The argument that put it there is
// M5-1's, and it is general — "an inequality between three constants in three
// route files is a coincidence maintained by hand", and a per-IP gate bounds
// one address rather than reserving anything for anybody.
//
// TWO OTHER GLOBAL DAILY CEILINGS WERE REACHED FROM THE SAME DOORS AND HAD NO
// SUCH RESERVE:
//
//   services/weatherService.js  WX_DAILY = 950.  routes/publicCrowd.js
//     (allowDemo, 600 requests a day) and routes/badge.js (BADGE_DAILY, 600)
//     both called getWeather with no caller identity, so between them the two
//     doors with nobody behind them could ask for 1200 readings against 950.
//     MEASURED on the live preview: four anonymous GET /api/public/demo/venues
//     requests moved the shared meter from 23 to 28.
//
//   services/mlPredictor.js  EVENT_DAILY_BUDGET = 1500.  Worse arithmetic.
//     MEASURED against the real module: one predictBusyness is 1 Ticketmaster
//     call and one predictHourlyForecast(24) is 23 more, so ONE public venue
//     card is 24. Sixty-three of them empties the day for the whole product,
//     out of the 600 requests allowDemo will serve — a tenth of the demo's own
//     permitted traffic.
//
// Neither ceiling is denominated in money (OpenWeatherMap's free plan covers a
// million calls a month and Ticketmaster's public tier is 5,000 a day, per
// services/costModel.js), so what is at stake is not a bill. It is the thing
// exhausting them causes: allowWeatherFetch and allowEventFetch both fail SOFT,
// so once the day is gone every crowd score, every advisor card and every
// Monday digest quietly drops its weather factor and its event enrichment until
// UTC midnight, for every user, with nothing on screen to say so.
//
// WHAT "ANONYMOUS" MEANS HERE, and why it is not "no userId". Background
// producers pass no id either — services/crowdAlerts.js, the ML collection
// scripts, the night-context sweep — and they are our own traffic rather than
// unattributable traffic. Putting them in the same bucket would let demo load
// starve a scheduled job. So the public door declares itself with
// { anonymous: true }, and absence of an id keeps the behaviour it had.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.WEATHER_API_KEY = process.env.WEATHER_API_KEY || 'test-key';
process.env.TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY || 'test-key';

const weatherService = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');

const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// A stub upstream, so nothing in this file can reach a vendor. Both ledgers
// charge BEFORE the fetch, which is what makes counting the meter rather than
// counting the fetch the right measurement.
const realFetch = global.fetch;
function stubFetch() {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('openweathermap')) {
      return {
        ok: true,
        json: async () => ({
          main: { temp: 60, feels_like: 60, humidity: 50 },
          wind: { speed: 5 },
          weather: [{ main: 'Clear', id: 800, description: 'clear sky' }],
        }),
      };
    }
    if (u.includes('ticketmaster')) return { ok: true, json: async () => ({ _embedded: { events: [] } }) };
    throw new Error(`unexpected upstream in a reserve test: ${u.slice(0, 60)}`);
  };
}
function restoreFetch() { global.fetch = realFetch; }

// ---------------------------------------------------------------------------
// WEATHER
// ---------------------------------------------------------------------------
//
// WX_PER_MINUTE (55) is far below WX_UNAUTH_DAILY, so reaching the daily wall
// in real time is impossible inside one test. The clock is advanced instead,
// by a minute every fifty charges, which exercises the real minute rollover
// rather than stepping around it. The UTC day never rolls: eighteen virtual
// minutes.
test('an anonymous flood cannot spend the whole weather day', async () => {
  stubFetch();
  const realNow = Date.now.bind(Date);
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    weatherService.__resetWeatherState();
    const { WX_DAILY, WX_UNAUTH_DAILY } = weatherService.__test;

    for (let i = 0; i < WX_UNAUTH_DAILY + 250; i++) {
      if (i % 50 === 0) offset += 61_000;
      // Distinct 2dp buckets, so nothing is served from cache and every call is
      // a real charge. This is the enumeration shape the module's own header
      // names as the one that spends a day.
      await weatherService.getWeather(40 + (i % 300) * 0.01, -75 - Math.floor(i / 300) * 0.01, { anonymous: true });
    }

    const s = weatherService.weatherBudgetStatus();
    assert.strictEqual(s.unauthUsed, WX_UNAUTH_DAILY,
      'the anonymous share is a wall: it must stop exactly at WX_UNAUTH_DAILY however hard it is pushed');
    assert.strictEqual(s.dailyUsed, WX_UNAUTH_DAILY,
      'and it must not have reached past its share into the day');
    assert.strictEqual(s.dailyRemaining, WX_DAILY - WX_UNAUTH_DAILY,
      'the reserve is what is left, and it is left whatever the public doors did');

    // The reserve is only a reserve if somebody can still spend it.
    offset += 61_000;
    const before = weatherService.weatherBudgetStatus().dailyUsed;
    const reading = await weatherService.getWeather(12.34, 56.78, { userId: 99 });
    const after = weatherService.weatherBudgetStatus().dailyUsed;
    assert.ok(reading, 'an authenticated caller must still get a reading after the anonymous flood');
    assert.strictEqual(after, before + 1, 'and it must be charged, like every other reading');
  } finally {
    Date.now = realNow;
    restoreFetch();
    weatherService.__resetWeatherState();
  }
});

test('weather: absence of a userId is not the same thing as anonymous', async () => {
  stubFetch();
  try {
    weatherService.__resetWeatherState();
    // A background producer (crowdAlerts, the night-context sweep, the ML
    // scripts) passes neither an id nor the marker. It charges the day and
    // nothing else, which is the behaviour it has always had.
    await weatherService.getWeather(41.11, -76.11);
    const s = weatherService.weatherBudgetStatus();
    assert.strictEqual(s.dailyUsed, 1, 'a background call still charges the day');
    assert.strictEqual(s.unauthUsed, 0,
      'but it must not eat the public share, or demo load could starve a scheduled job');
  } finally {
    restoreFetch();
    weatherService.__resetWeatherState();
  }
});

// ---------------------------------------------------------------------------
// EVENTS
// ---------------------------------------------------------------------------

const eventVenue = (i) => ({
  place_id: `reserve-probe-${i}`,
  name: 'Reserve Probe',
  types: ['bar'],
  // Distinct 3dp buckets: eventCache keys on lat/lng to three places plus the
  // UTC hour, so every one of these is a genuine miss.
  location: { latitude: 40 + i * 0.01, longitude: -75 - i * 0.01 },
  rating: 4, user_ratings_total: 100, price_level: 2,
  utcOffsetMinutes: -240, isOpen: true,
  hoursByDay: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ open: 9, close: 23, closeMinute: 0 }]])),
});

test('an anonymous flood cannot spend the whole Ticketmaster event day', async () => {
  stubFetch();
  try {
    const limits = mlPredictor.eventBudgetStatus().limits;
    const at = new Date();
    for (let i = 0; i < limits.unauthDaily + 100; i++) {
      await mlPredictor.predictBusyness(eventVenue(i), null, at, { anonymous: true });
    }
    const e = mlPredictor.eventBudgetStatus();
    assert.strictEqual(e.unauthUsed, limits.unauthDaily,
      'the anonymous share is a wall: EVENT_UNAUTH_DAILY and no further');
    assert.strictEqual(e.globalRemaining, limits.globalDaily - limits.unauthDaily,
      'and the reserve is what the signed-in product keeps, whatever the demo did');

    const before = mlPredictor.eventBudgetStatus().globalUsed;
    await mlPredictor.predictBusyness(eventVenue(50_000), null, at, { userId: 99 });
    const after = mlPredictor.eventBudgetStatus().globalUsed;
    assert.strictEqual(after, before + 1,
      'an authenticated caller must still be able to spend the reserve after the flood');
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// THE INEQUALITIES, and the doors that have to keep declaring themselves
// ---------------------------------------------------------------------------

test('the weather share clears the largest single unauthenticated door', () => {
  const { WX_DAILY, WX_UNAUTH_DAILY, WX_PER_USER_HOURLY } = weatherService.__test;

  // Upward, the constraint placesBudget states: a sub-ceiling BELOW the door it
  // sits over never binds, so it silently repeals that door's own limit. The
  // two doors are routes/publicCrowd.js allowDemo (600 requests a day) and
  // routes/badge.js BADGE_DAILY (600), read out of the source rather than
  // retyped, so raising either one fails this test instead of quietly winning.
  const demoDaily = Number(/if \(dayCount >= (\d+)\) return false;/.exec(SRC('routes/publicCrowd.js'))[1]);
  const badgeDaily = Number(/const BADGE_DAILY = (\d+);/.exec(SRC('routes/badge.js'))[1]);
  const largestDoor = Math.max(demoDaily, badgeDaily);
  assert.ok(WX_UNAUTH_DAILY > largestDoor,
    `WX_UNAUTH_DAILY (${WX_UNAUTH_DAILY}) must stay strictly above the largest unauthenticated door (${largestDoor}), or that door's own daily limit stops binding`);

  // Downward, the reserve has to be worth having: more than a single account
  // can spend in an hour, so one signed-in caller cannot consume it either.
  assert.ok(WX_DAILY - WX_UNAUTH_DAILY > WX_PER_USER_HOURLY,
    'the reserve must be larger than one account\'s hourly allowance');
});

test('the event share leaves more than one account can drain', () => {
  const { globalDaily, unauthDaily, perUserDaily } = mlPredictor.eventBudgetStatus().limits;
  assert.ok(unauthDaily < globalDaily, 'the anonymous share must be a share, not the whole day');
  assert.ok(globalDaily - unauthDaily > perUserDaily,
    `the reserve (${globalDaily - unauthDaily}) must exceed EVENT_USER_DAILY (${perUserDaily}), or one account can drain what the demo cannot`);
});

test('every door with no account still declares itself', () => {
  // The reserve is only real while the public doors pass the marker. These are
  // the two files with no authenticated caller anywhere in them; a third one
  // added later has to be added here too, which is the point of pinning it.
  for (const rel of ['routes/publicCrowd.js', 'routes/badge.js']) {
    const src = SRC(rel);
    assert.match(src, /const ANON = Object\.freeze\(\{ anonymous: true \}\);/,
      `${rel} must define the anonymous marker`);
    assert.ok(!/await getWeather\([^)]*\)\.catch/.test(src.replace(/getWeather\([^)]*ANON[^)]*\)/g, 'MARKED')),
      `${rel} has a getWeather call that does not pass ANON`);
  }
});

test('the claim in the source says what the code does', () => {
  const wx = SRC('services/weatherService.js');
  assert.match(wx, /const WX_UNAUTH_DAILY = \d+;/, 'the weather share must be a named constant');
  assert.match(wx, /if \(anonymous && wxUnauthDayCount >= WX_UNAUTH_DAILY\) return refuse\('unauthenticated share'\);/,
    'and it must be checked before either counter moves, so a refused call is charged nothing');

  const ml = SRC('services/mlPredictor.js');
  assert.match(ml, /const EVENT_UNAUTH_DAILY = \d+;/, 'the event share must be a named constant');
  assert.match(ml, /if \(anonymous && eventUnauthDayCount >= EVENT_UNAUTH_DAILY\) return false;/,
    'and it must be checked before either counter moves');
  // The file used to conclude that the demo needed no share because it "already
  // has its own per-IP gate". That sentence still appears, quoted inside the
  // paragraph that disproves it, which is why this pins the CORRECTION rather
  // than the absence of the claim.
  assert.match(ml, /A\r?\n\/\/ per-IP gate bounds one address; it does not reserve anything for anybody\./,
    'the file must say why a per-IP gate is not a reserve, next to the constant that is one');
});
