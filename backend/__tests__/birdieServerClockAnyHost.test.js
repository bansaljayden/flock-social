// Run: node --test  (from backend/)
//
// THE UTC FALLBACK IS UTC ON ANY HOST (routes/ai.js, WHOSE CLOCK, in
// get_crowd_prediction).
//
// A venue nothing knows the time of, asked about on a turn without the user's
// clock, is scored as if it kept UTC. Production's host keeps UTC, so that was
// right there by accident. On a host in New York the tool picked the UTC hour
// but handed the predictor a venue with no zone and no offset, and a timestamp
// built on the host's own clock:
//   * at 18:30Z it scored "6 PM", and the predictor read that slot's weather
//     and events at 22:00Z, because a venue with no clock has its timestamp
//     read as an instant on the host's clock;
//   * at 02:30Z on 2027-03-14 the host-local setHours(2) landed in New York's
//     spring-forward gap and came back as 3 AM, so the current UTC hour was
//     scored and labelled as the next one.
//
// The predictor reads every feature off the timestamp's host-local fields
// (the venue wall clock encoded in server time), so this file runs the tool
// on a New York host clock and checks what the predictor would build from
// what the tool hands it, with the predictor's own venue-clock functions.

process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'birdie-server-clock-any-host-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
delete process.env.POSTHOG_API_KEY;
delete process.env.CROWD_NO_CURVE_FALLBACK;

// No corpus zone, no owner reading, no reports: every read answers empty.
const pool = require('../config/database');
pool.query = () => Promise.resolve({ rows: [], rowCount: 0 });

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;

// The predictor, faked so it records what the tool hands it. Its own
// venue-clock functions stay real; they are what the assertions read.
const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const { forecastSlots, venueInstant } = mlPredictor._internals;
let scored = []; // { venue, ts } the headline was scored on
let strips = []; // { venue, startHour, base } the strip was asked for
mlPredictor.predictBusyness = async (venue, _weather, ts) => {
  scored.push({ venue, ts: new Date(ts) });
  return {
    score: 55, label: crowdEngine.getLabel(55), confidence: 60, factors: {},
    dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test',
  };
};
mlPredictor.predictHourlyForecast = async (venue, _weather, startHour, count, base) => {
  strips.push({ venue, startHour, base: new Date(base) });
  return Array.from({ length: count || 12 }, (_, i) => ({
    hour: `${(startHour + i) % 24}`, score: 55, label: crowdEngine.getLabel(55), predictionMethod: 'ml',
  }));
};

// A venue Google sends no clock for, and the corpus holds no zone for.
const PLACE_ID = 'PLACE_NO_CLOCK_ANY_HOST';
const CLOCKLESS = {
  id: PLACE_ID,
  displayName: { text: 'Clockless Cafe' },
  formattedAddress: '1 Main St',
  rating: 4.4,
  userRatingCount: 300,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  types: ['cafe'],
  location: { latitude: 39.95, longitude: -75.16 },
  currentOpeningHours: { openNow: true, periods: [] },
};
const realFetch = global.fetch;
global.fetch = (url) => (String(url).startsWith('https://places.googleapis.com/')
  ? Promise.resolve({ ok: true, status: 200, json: async () => CLOCKLESS })
  : Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
test.after(() => { global.fetch = realFetch; });

const placeDetailsCache = require('../services/placeDetailsCache');
const { executeTool } = require('../routes/ai').__testables;

let nextUserId = 9400;
test.beforeEach(() => {
  placeDetailsCache.__test.reset();
  scored = [];
  strips = [];
});

// What the tool loop hands the crowd tool on a turn without the user's clock
// (a yes to the earlier question, or an installed build): no hour, no day, no
// zone.
const earlierYesLookup = () => executeTool(
  'get_crowd_prediction', { place_id: PLACE_ID }, ++nextUserId,
  { includeForecast: true, salesOff: false, searchedPlaces: new Map(), timeZone: null },
);

const topOfHour = (ms) => ms - (ms % 3_600_000);

test('this file really runs on a New York host clock', () => {
  assert.strictEqual(new Date('2026-10-07T18:30:00Z').getHours(), 14);
  // And 2 AM on 2027-03-14 is a time that host's clock skips.
  assert.strictEqual(new Date(2027, 2, 14, 2).getHours(), 3);
});

// Every hour the tool and the predictor work with on this path is the UTC hour
// it claims to be: the headline's, the instant its events are read at, and each
// slot of the strip the predictor would walk from what it was handed.
async function assertUtcAllTheWay(t, nowIso) {
  const nowMs = Date.parse(nowIso);
  t.mock.timers.enable({ apis: ['Date'], now: nowMs });
  const utcHour = new Date(nowMs).getUTCHours();
  const out = await earlierYesLookup();
  assert.ok(out && !out.error, `${nowIso}: ${JSON.stringify(out)}`);
  assert.strictEqual(out.clock, 'UTC', `${nowIso}: not scored on UTC`);

  // The headline: scored at the UTC hour, and read at that hour's real start.
  assert.strictEqual(scored[0].ts.getHours(), utcHour, `${nowIso}: headline scored at hour ${scored[0].ts.getHours()}`);
  assert.strictEqual(
    venueInstant(scored[0].ts, scored[0].venue).getTime(), topOfHour(nowMs),
    `${nowIso}: the headline's events are read at ${venueInstant(scored[0].ts, scored[0].venue).toISOString()}`,
  );

  // The strip: asked for the UTC hour from a timestamp already at that hour,
  // so the predictor's own setHours(start) on it changes nothing.
  assert.strictEqual(strips[0].startHour, utcHour);
  assert.strictEqual(strips[0].base.getHours(), utcHour, `${nowIso}: the strip's base reads hour ${strips[0].base.getHours()}`);
  const slots = forecastSlots(strips[0].venue, strips[0].base, 24, nowMs);
  assert.ok(slots.length >= 23, `${nowIso}: only ${slots.length} slots`);
  assert.strictEqual(slots[0].instantMs, topOfHour(nowMs), `${nowIso}: the first slot stands for ${new Date(slots[0].instantMs).toISOString()}`);
  let prev = -Infinity;
  for (const s of slots) {
    const at = new Date(s.instantMs);
    // Each slot is labelled and scored on the UTC hour and date its weather
    // and events are read at, and none comes back out of order.
    assert.strictEqual(s.ts.getHours(), at.getUTCHours(), `${nowIso}: a slot labelled ${s.ts.getHours()} stands for ${at.toISOString()}`);
    assert.strictEqual(s.ts.getDate(), at.getUTCDate(), `${nowIso}: a slot dated ${s.ts.getDate()} stands for ${at.toISOString()}`);
    assert.ok(s.instantMs > prev, `${nowIso}: slots out of order`);
    prev = s.instantMs;
  }
}

test("6:30 PM UTC on a New York host: 6 PM is read at 18:00Z, never at the host's 22:00Z", async (t) => {
  await assertUtcAllTheWay(t, '2026-10-07T18:30:00Z');
});

test('the hours either side of the host clock changes stay the UTC hours they claim to be', async (t) => {
  // 01:30Z on 2026-11-01: the UTC hour is 1 AM, a time the host's clock shows
  // twice that night.
  await assertUtcAllTheWay(t, '2026-11-01T01:30:00Z');
  t.mock.timers.reset();
  placeDetailsCache.__test.reset();
  scored = [];
  strips = [];
  // 01:30Z on 2027-03-14: the strip runs into 2 AM UTC, which the host's clock
  // skips, and skips it rather than calling 3 AM by its name.
  await assertUtcAllTheWay(t, '2027-03-14T01:30:00Z');
  t.mock.timers.reset();
  placeDetailsCache.__test.reset();
  scored = [];
  strips = [];
  await assertUtcAllTheWay(t, '2027-03-14T03:30:00Z');
});

test("inside the host's spring-forward gap the current UTC hour is never scored as the next one", async (t) => {
  // 02:30Z on 2027-03-14. The UTC hour is 2 AM, and the predictor reads its
  // hour off the host's clock, which has no 2 AM that day. It used to be
  // handed 3 AM under the current hour's name. Now nothing is scored at an
  // hour it is not, and with no way to hand over 2 AM there is no reading.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-03-14T02:30:00Z') });
  const out = await earlierYesLookup();
  for (const s of scored) assert.strictEqual(s.ts.getHours(), 2, `the headline was scored at hour ${s.ts.getHours()}`);
  for (const s of strips) {
    assert.strictEqual(s.startHour, 2);
    assert.strictEqual(s.base.getHours(), 2, `the strip was built from hour ${s.base.getHours()}`);
  }
  assert.ok(!('crowd_score' in out) && !('hourly_forecast' in out), `a reading went out: ${JSON.stringify(out)}`);
  assert.match(out.error, /no crowd reading for this venue right now/i);
  assert.match(out.error, /do not guess/i);
});
