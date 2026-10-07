// Run: node --test  (from backend/)
//
// EVERY CLOCK A VENUE IS SCORED ON IS RIGHT ON ANY HOST (routes/ai.js, WHOSE
// CLOCK, in get_crowd_prediction).
//
// The crowd tool reads a venue's hour from Google's zone or offset for it, from
// the zone the crowd corpus holds, from the user's own clock where the turn may
// carry it, or else from UTC. The predictor reads every feature off the
// timestamp it is handed, on THIS process's clock (the venue wall clock encoded
// in server time). Production's host keeps UTC, so building that timestamp with
// setHours on the host's clock was right there by accident. On a host in New
// York:
//   * at 18:30Z a venue scored on UTC was scored at "6 PM" with no zone, and the
//     predictor read that slot's weather and events at 22:00Z;
//   * at 02:30Z on 2027-03-14 setHours(2) fell into New York's spring-forward
//     gap and came back as 3 AM, so the current hour was scored, and could go
//     on the card, as the next one. Every source of the hour did this: UTC,
//     the corpus zone, Google's zone, Google's offset and the user's clock.
//
// This file runs the tool on a New York host clock and checks what the
// predictor would build from what the tool hands it, with the predictor's own
// venue-clock functions.

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

// The corpus zone for the venue (ml_venues.timezone), or null for no row. No
// owner reading and no reports: every other read answers empty.
const pool = require('../config/database');
let corpusZone = null;
pool.query = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (/^SELECT timezone FROM ml_venues WHERE google_place_id = \$1 LIMIT 1$/.test(flat)) {
    return Promise.resolve(corpusZone ? { rows: [{ timezone: corpusZone }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;

// The predictor, faked so it records what the tool hands it. Its own
// venue-clock functions stay real; they are what the assertions read.
const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const { forecastSlots, venueInstant } = mlPredictor._internals;
const { civilTime } = require('../utils/venueZone');
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

// The venue's Places details: no clock unless a test gives it one.
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
let placeClock = {};
const realFetch = global.fetch;
global.fetch = (url) => (String(url).startsWith('https://places.googleapis.com/')
  ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ...CLOCKLESS, ...placeClock }) })
  : Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
test.after(() => { global.fetch = realFetch; });

const placeDetailsCache = require('../services/placeDetailsCache');
const { executeTool } = require('../routes/ai').__testables;

let nextUserId = 9400;
function freshLookup() {
  placeDetailsCache.__test.reset();
  scored = [];
  strips = [];
}
test.beforeEach(() => {
  freshLookup();
  placeClock = {};
  corpusZone = null;
});

// What the tool loop hands the crowd tool. With no options it is a turn
// without the user's clock (a yes to the earlier question, or an installed
// build): no hour, no day, no zone. A turn with the user's clock adds them.
const lookup = (opts = {}) => executeTool(
  'get_crowd_prediction', { place_id: PLACE_ID }, ++nextUserId,
  { includeForecast: true, salesOff: false, searchedPlaces: new Map(), timeZone: null, ...opts },
);

const topOfHour = (ms) => ms - (ms % 3_600_000);
// The venue's wall clock at an instant, three ways a test can know it.
const onZone = (zone) => (ms) => { const c = civilTime(ms, zone); return { hour: c.hour, date: c.day }; };
const onOffset = (minutes) => (ms) => {
  const at = new Date(ms + minutes * 60_000);
  return { hour: at.getUTCHours(), date: at.getUTCDate() };
};

test('this file really runs on a New York host clock', () => {
  assert.strictEqual(new Date('2026-10-07T18:30:00Z').getHours(), 14);
  // And 2 AM on 2027-03-14 is a time that host's clock skips.
  assert.strictEqual(new Date(2027, 2, 14, 2).getHours(), 3);
});

// Every hour the tool and the predictor work with is the hour it claims to be
// on the venue's clock: the headline's, the instant its events are read at, and
// each slot of the strip the predictor would walk from what it was handed.
async function assertOnClock(t, nowIso, wallOf, { opts = {}, clock } = {}) {
  const nowMs = Date.parse(nowIso);
  t.mock.timers.enable({ apis: ['Date'], now: nowMs });
  try {
    const now = wallOf(nowMs);
    const out = await lookup(opts);
    assert.ok(out && !out.error, `${nowIso}: ${JSON.stringify(out)}`);
    if (clock) assert.strictEqual(out.clock, clock, `${nowIso}: scored on ${out.clock}`);
    else assert.ok(!('clock' in out), `${nowIso}: a venue on its own clock was called ${out.clock}`);

    // The headline: scored at the venue's hour, and read at that hour's real start.
    assert.strictEqual(scored[0].ts.getHours(), now.hour, `${nowIso}: headline scored at hour ${scored[0].ts.getHours()}`);
    assert.strictEqual(scored[0].ts.getDate(), now.date, `${nowIso}: headline scored on day ${scored[0].ts.getDate()}`);
    assert.strictEqual(
      venueInstant(scored[0].ts, scored[0].venue).getTime(), topOfHour(nowMs),
      `${nowIso}: the headline's events are read at ${venueInstant(scored[0].ts, scored[0].venue).toISOString()}`,
    );

    // The strip: asked for the venue's hour from a timestamp already at that
    // hour, so the predictor's own setHours(start) on it changes nothing.
    assert.strictEqual(strips[0].startHour, now.hour);
    assert.strictEqual(strips[0].base.getHours(), now.hour, `${nowIso}: the strip's base reads hour ${strips[0].base.getHours()}`);
    const slots = forecastSlots(strips[0].venue, strips[0].base, 24, nowMs);
    assert.ok(slots.length >= 23, `${nowIso}: only ${slots.length} slots`);
    assert.strictEqual(slots[0].instantMs, topOfHour(nowMs), `${nowIso}: the first slot stands for ${new Date(slots[0].instantMs).toISOString()}`);
    let prev = -Infinity;
    for (const s of slots) {
      const wall = wallOf(s.instantMs);
      // Each slot is labelled and scored on the hour and date the venue's clock
      // reads at the instant its weather and events are read at, in order.
      assert.strictEqual(s.ts.getHours(), wall.hour, `${nowIso}: a slot labelled ${s.ts.getHours()} stands for ${new Date(s.instantMs).toISOString()}`);
      assert.strictEqual(s.ts.getDate(), wall.date, `${nowIso}: a slot dated ${s.ts.getDate()} stands for ${new Date(s.instantMs).toISOString()}`);
      assert.ok(s.instantMs > prev, `${nowIso}: slots out of order`);
      prev = s.instantMs;
    }
  } finally {
    t.mock.timers.reset();
  }
}

test("6:30 PM UTC on a New York host: 6 PM on UTC is read at 18:00Z, never at the host's 22:00Z", async (t) => {
  await assertOnClock(t, '2026-10-07T18:30:00Z', onZone('UTC'), { clock: 'UTC' });
});

test('the hours either side of the host clock changes stay the UTC hours they claim to be', async (t) => {
  // 01:30Z on 2026-11-01: the UTC hour is 1 AM, a time the host's clock shows
  // twice that night.
  await assertOnClock(t, '2026-11-01T01:30:00Z', onZone('UTC'), { clock: 'UTC' });
  freshLookup();
  // 01:30Z on 2027-03-14: the strip runs into 2 AM UTC, which the host's clock
  // skips, and skips it rather than calling 3 AM by its name.
  await assertOnClock(t, '2027-03-14T01:30:00Z', onZone('UTC'), { clock: 'UTC' });
  freshLookup();
  await assertOnClock(t, '2027-03-14T03:30:00Z', onZone('UTC'), { clock: 'UTC' });
});

test("on an ordinary hour, every venue clock is read as itself on this host", async (t) => {
  const NOW = '2026-10-07T18:30:00Z';
  // The corpus's zone, on a turn that also carries the user's clock: the
  // venue's own clock comes first.
  corpusZone = 'UTC';
  await assertOnClock(t, NOW, onZone('UTC'), { opts: { localHour: 21, localDay: 6, timeZone: 'America/New_York' } });
  freshLookup();
  corpusZone = null;
  // Google's zone for it: London, an hour ahead of UTC in October.
  placeClock = { timeZone: { id: 'Europe/London' }, utcOffsetMinutes: 60 };
  await assertOnClock(t, NOW, onZone('Europe/London'));
  freshLookup();
  // Google's offset for it, and no zone.
  placeClock = { utcOffsetMinutes: 60 };
  await assertOnClock(t, NOW, onOffset(60));
});

test("a venue read on the user's clock has its weather and events read in the user's zone", async (t) => {
  // No clock from Google or the corpus, on a turn that carries the user's
  // clock: a phone in London at 7:30 PM on Wednesday. The hour is the phone's,
  // and the instant it stands for is 7 PM in London, 18:00Z. With no zone
  // beside it the predictor read the phone's 7 PM on the host's clock: 23:00Z
  // here, and 19:00Z on a host that keeps UTC, which is production.
  await assertOnClock(t, '2026-10-07T18:30:00Z', onZone('Europe/London'), {
    opts: { localHour: 19, localDay: 3, timeZone: 'Europe/London' },
  });
});

// INSIDE THE HOST'S SPRING-FORWARD GAP. 02:30Z on 2027-03-14 is 2 AM on UTC's
// clock and on London's (on GMT until the 28th), and the predictor reads its
// hour off the host's clock, which has no 2 AM that day. Each of these used to
// be handed 3 AM under the current hour's name. Now nothing is scored at an
// hour it is not, and with no way to hand over 2 AM there is no reading.
const GAP_CASES = [
  ['the corpus holds UTC for it, asked with the user\'s clock from New York',
    () => { corpusZone = 'UTC'; }, { localHour: 21, localDay: 6, timeZone: 'America/New_York' }],
  ["Google names its zone, London", () => { placeClock = { timeZone: { id: 'Europe/London' }, utcOffsetMinutes: 0 }; }, {}],
  ["Google gives only its offset, UTC+0", () => { placeClock = { utcOffsetMinutes: 0 }; }, {}],
  ["the user's own clock, a phone in London at 2:30 AM on Sunday", () => {}, { localHour: 2, localDay: 0, timeZone: 'Europe/London' }],
  ['UTC, with nothing else to go on', () => {}, {}],
];
for (const [what, setup, opts] of GAP_CASES) {
  test(`in the host's spring-forward gap, a venue on ${what} is never scored as the next hour`, async (t) => {
    setup();
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-03-14T02:30:00Z') });
    const out = await lookup(opts);
    for (const s of scored) assert.strictEqual(s.ts.getHours(), 2, `the headline was scored at hour ${s.ts.getHours()}`);
    for (const s of strips) {
      assert.strictEqual(s.startHour, 2);
      assert.strictEqual(s.base.getHours(), 2, `the strip was built from hour ${s.base.getHours()}`);
    }
    // No number to put on the card as the level now, and nothing to quote.
    assert.ok(!('crowd_score' in out) && !('hourly_forecast' in out), `a reading went out: ${JSON.stringify(out)}`);
    assert.match(out.error, /no crowd reading for this venue right now/i);
    assert.match(out.error, /do not guess/i);
  });
}
