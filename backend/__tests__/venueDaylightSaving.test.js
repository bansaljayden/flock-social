// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A VENUE'S OWN CLOCK CHANGE, SLOT BY SLOT.
//
// On Saturday 2026-10-31 Google says a New York venue is at utcOffsetMinutes
// -240. At 2 AM on Sunday 2026-11-01 its clocks go back to 1 AM and it is at
// -300; at 2 AM on 2027-03-14 they jump to 3 AM and it is at -240 again. While
// the predictor held only the one offset, every forecast slot after a change
// had its weather and its Ticketmaster window read an hour early, and the strip
// drew a 2 AM the wall clock never shows. The venue shape now carries Google's
// IANA zone (`timeZone`) and the strip walks the venue's wall clock through it
// (services/mlPredictor.js forecastSlots, utils/venueZone.js).
//
// What is pinned, for both changes and on both sides of each:
//   * the labels: the hour the clock skips is not emitted, and the hour it
//     shows twice is emitted once;
//   * the real instant each slot stands for, which is what its weather and its
//     event window are read at, end to end through predictHourlyForecast with
//     the clock frozen on the night;
//   * a venue with no zone keeps the one offset, exactly as before;
//   * none of it depends on the server's own zone. Railway runs UTC; a
//     developer machine in New York has the same changes on the same nights.
// ---------------------------------------------------------------------------

// Railway's clock for the whole file, set before anything reads a Date. The
// zone the machine really runs is put back at the end.
const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
process.env.TZ = 'UTC';
delete process.env.TICKETMASTER_API_KEY;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'venue-daylight-saving-test-secret';
// Must be set before requiring routes/crowd.js: API_KEY is a module-load const.
process.env.GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || 'test-key';

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Baselines, feedback and neighbours are read from Postgres. None is under test
// and none may reach a real server; with no rows every hour is scored by the
// rule engine, which is where the per-slot weather is observed below.
const pool = require('../config/database');
pool.query = async () => ({ rows: [], rowCount: 0 });

const zone = require('../utils/venueZone');
const crowdEngine = require('../services/crowdEngine');
const weatherService = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');
const I = mlPredictor._internals;
const placeDetailsCache = require('../services/placeDetailsCache');
const { fetchVenueFromGoogle } = require('../routes/crowd').__testables;
const { toVenueShape } = require('../routes/publicCrowd').__testables;

const NY = 'America/New_York';
const HOUR = 60 * 60 * 1000;

before(async () => {
  await mlPredictor.init();
});

after(() => {
  process.env.TZ = SYSTEM_TZ;
});

// Run `fn` with the process in `tz`, then put UTC back.
async function inTz(tz, fn) {
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    process.env.TZ = 'UTC';
  }
}

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const label = (d) => {
  const h = d.getHours();
  return `${h === 0 ? 12 : h > 12 ? h - 12 : h} ${h >= 12 ? 'PM' : 'AM'}`;
};
// A venue wall-clock hour, encoded the way every caller encodes it: a Date
// whose server-local fields are the venue's.
const wall = (y, m, d, h) => new Date(y, m - 1, d, h, 0, 0, 0);
const slotsOf = (venue, y, m, d, h, count, nowIso) =>
  I.forecastSlots(venue, wall(y, m, d, h), count, Date.parse(nowIso))
    .map((s) => ({ hour: label(s.ts), at: iso(s.instantMs) }));

// A New York bar. `utcOffsetMinutes` is what Google said when the payload was
// fetched, which on the night of a change is the offset from BEFORE it.
function bar(over = {}) {
  return {
    place_id: 'dst-test-bar',
    name: 'Clock Change Bar',
    types: ['bar', 'point_of_interest', 'establishment'],
    rating: 4.3,
    price_level: 2,
    user_ratings_total: 500,
    location: { latitude: 40.72, longitude: -73.99 },
    timeZone: NY,
    utcOffsetMinutes: -240,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. THE ZONE NAMES BOTH NIGHTS EXACTLY
// ---------------------------------------------------------------------------

test('a wall-clock hour has one instant, none inside the spring gap, and two in the autumn overlap', () => {
  assert.deepEqual(zone.wallClockInstants(2026, 11, 1, 0, 0, NY).map(iso), ['2026-11-01T04:00:00Z']);
  assert.deepEqual(zone.wallClockInstants(2026, 11, 1, 1, 0, NY).map(iso),
    ['2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z'], '1 AM EDT, then 1 AM EST');
  assert.deepEqual(zone.wallClockInstants(2026, 11, 1, 2, 0, NY).map(iso), ['2026-11-01T07:00:00Z']);

  assert.deepEqual(zone.wallClockInstants(2027, 3, 14, 1, 0, NY).map(iso), ['2027-03-14T06:00:00Z']);
  assert.deepEqual(zone.wallClockInstants(2027, 3, 14, 2, 0, NY), [], 'the wall clock never reads 2 AM that night');
  assert.deepEqual(zone.wallClockInstants(2027, 3, 14, 3, 0, NY).map(iso), ['2027-03-14T07:00:00Z']);

  // The offset in force either side of each change.
  assert.equal(zone.zoneOffsetMinutes(Date.parse('2026-11-01T05:59:00Z'), NY), -240);
  assert.equal(zone.zoneOffsetMinutes(Date.parse('2026-11-01T06:00:00Z'), NY), -300);
  assert.equal(zone.zoneOffsetMinutes(Date.parse('2027-03-14T06:59:00Z'), NY), -300);
  assert.equal(zone.zoneOffsetMinutes(Date.parse('2027-03-14T07:00:00Z'), NY), -240);
});

test('the hour the clock shows twice means the showing that has not finished yet', () => {
  const oneAm = { year: 2026, month: 11, day: 1, hour: 1 };
  const at = (nowIso) => iso(zone.instantForWallClock(oneAm, NY, Date.parse(nowIso)));
  assert.equal(at('2026-10-31T18:00:00Z'), '2026-11-01T05:00:00Z', 'asked the evening before: the first 1 AM');
  assert.equal(at('2026-11-01T05:30:00Z'), '2026-11-01T05:00:00Z', 'asked during the first 1 AM: that one');
  assert.equal(at('2026-11-01T06:30:00Z'), '2026-11-01T06:00:00Z', 'asked during the second 1 AM: that one');
  assert.equal(at('2026-11-01T09:00:00Z'), '2026-11-01T05:00:00Z', 'asked afterwards: the first again');
  // A time the clock skips is read with the offset from before the change,
  // which lands on the instant the clock jumps to.
  assert.equal(iso(zone.instantForWallClock({ year: 2027, month: 3, day: 14, hour: 2 }, NY)),
    '2027-03-14T07:00:00Z');
});

test('an unusable zone is no zone, and Google\'s shape reads either way', () => {
  for (const bad of [null, undefined, '', 'Not/AZone', 42, {}, 'a'.repeat(80), '../etc/passwd']) {
    assert.equal(zone.validTimeZone(bad), null, `${String(bad)} is not a zone`);
  }
  assert.equal(zone.validTimeZone(NY), NY);
  assert.equal(zone.placeTimeZone({ timeZone: { id: NY, version: '2025b' } }), NY, 'the documented { id } shape');
  assert.equal(zone.placeTimeZone({ timeZone: NY }), NY);
  assert.equal(zone.placeTimeZone({ timeZone: { id: 'Not/AZone' } }), null);
  assert.equal(zone.placeTimeZone({}), null);
  assert.equal(zone.placeTimeZone(null), null);
});

// ---------------------------------------------------------------------------
// 2. THE STRIP'S HOURS AND INSTANTS, ON BOTH SIDES OF BOTH CHANGES
// ---------------------------------------------------------------------------

const FALL_NOW = '2026-11-01T04:30:00Z';   // 12:30 AM EDT, half an hour before the first 1 AM
const SPRING_NOW = '2027-03-14T05:30:00Z'; // 12:30 AM EST

function assertFallBack() {
  const venue = bar();
  // Before: Saturday night, all EDT.
  assert.deepEqual(slotsOf(venue, 2026, 10, 31, 22, 3, FALL_NOW), [
    { hour: '10 PM', at: '2026-11-01T02:00:00Z' },
    { hour: '11 PM', at: '2026-11-01T03:00:00Z' },
    { hour: '12 AM', at: '2026-11-01T04:00:00Z' },
  ]);
  // Across: 1 AM once, at its first showing, and 2 AM is next, at EST.
  assert.deepEqual(slotsOf(venue, 2026, 11, 1, 0, 6, FALL_NOW), [
    { hour: '12 AM', at: '2026-11-01T04:00:00Z' },
    { hour: '1 AM', at: '2026-11-01T05:00:00Z' },
    { hour: '2 AM', at: '2026-11-01T07:00:00Z' },
    { hour: '3 AM', at: '2026-11-01T08:00:00Z' },
    { hour: '4 AM', at: '2026-11-01T09:00:00Z' },
    { hour: '5 AM', at: '2026-11-01T10:00:00Z' },
  ]);
  // After: all EST.
  assert.deepEqual(slotsOf(venue, 2026, 11, 1, 3, 3, FALL_NOW), [
    { hour: '3 AM', at: '2026-11-01T08:00:00Z' },
    { hour: '4 AM', at: '2026-11-01T09:00:00Z' },
    { hour: '5 AM', at: '2026-11-01T10:00:00Z' },
  ]);
  // A strip that starts during the SECOND 1 AM starts at that 1 AM.
  assert.deepEqual(slotsOf(venue, 2026, 11, 1, 1, 2, '2026-11-01T06:30:00Z'), [
    { hour: '1 AM', at: '2026-11-01T06:00:00Z' },
    { hour: '2 AM', at: '2026-11-01T07:00:00Z' },
  ]);
}

function assertSpringForward() {
  // What Google said on Saturday: EST.
  const venue = bar({ utcOffsetMinutes: -300 });
  assert.deepEqual(slotsOf(venue, 2027, 3, 13, 22, 3, SPRING_NOW), [
    { hour: '10 PM', at: '2027-03-14T03:00:00Z' },
    { hour: '11 PM', at: '2027-03-14T04:00:00Z' },
    { hour: '12 AM', at: '2027-03-14T05:00:00Z' },
  ]);
  // Across: no 2 AM, and the instants stay one real hour apart.
  assert.deepEqual(slotsOf(venue, 2027, 3, 14, 0, 6, SPRING_NOW), [
    { hour: '12 AM', at: '2027-03-14T05:00:00Z' },
    { hour: '1 AM', at: '2027-03-14T06:00:00Z' },
    { hour: '3 AM', at: '2027-03-14T07:00:00Z' },
    { hour: '4 AM', at: '2027-03-14T08:00:00Z' },
    { hour: '5 AM', at: '2027-03-14T09:00:00Z' },
    { hour: '6 AM', at: '2027-03-14T10:00:00Z' },
  ]);
  // After: all EDT.
  assert.deepEqual(slotsOf(venue, 2027, 3, 14, 3, 3, SPRING_NOW), [
    { hour: '3 AM', at: '2027-03-14T07:00:00Z' },
    { hour: '4 AM', at: '2027-03-14T08:00:00Z' },
    { hour: '5 AM', at: '2027-03-14T09:00:00Z' },
  ]);
  // Asked to start at the hour that does not exist, the strip starts at the
  // hour the clock jumps to.
  assert.deepEqual(slotsOf(venue, 2027, 3, 14, 2, 2, SPRING_NOW), [
    { hour: '3 AM', at: '2027-03-14T07:00:00Z' },
    { hour: '4 AM', at: '2027-03-14T08:00:00Z' },
  ]);
}

test('fall back 2026-11-01: 1 AM is one slot, and every slot starts at its real instant', () => {
  assertFallBack();
});

test('spring forward 2027-03-14: there is no 2 AM slot, and the instants stay an hour apart', () => {
  assertSpringForward();
});

test('the same hours and instants on a server that itself runs New York time', async () => {
  // A developer machine. Its own clock changes on the same nights, so the
  // Dates the model reads are built on a clock with the same gap and overlap.
  await inTz(NY, () => {
    assertFallBack();
    assertSpringForward();
  });
});

test('a 24-slot strip is 24 slots either night', () => {
  const fall = slotsOf(bar(), 2026, 10, 31, 20, 24, '2026-11-01T00:30:00Z');
  assert.equal(fall.length, 24);
  assert.equal(new Set(fall.map((s) => s.hour)).size, 24, 'no wall-clock hour repeats, so every label is distinct');
  assert.equal(fall[0].at, '2026-11-01T00:00:00Z');
  assert.equal(fall[23].hour, '7 PM', 'Saturday 8 PM to Sunday 7 PM: 24 wall-clock hours in 25 real ones');
  assert.equal(fall[23].at, '2026-11-02T00:00:00Z', '7 PM Sunday is EST; Saturday\'s offset put it at 23:00Z');

  const spring = slotsOf(bar({ utcOffsetMinutes: -300 }), 2027, 3, 13, 20, 24, '2027-03-14T01:30:00Z');
  assert.equal(spring.length, 24);
  assert.ok(!spring.some((s) => s.hour === '2 AM'), 'no 2 AM on Sunday');
  assert.equal(spring[23].hour, '8 PM', '25 wall-clock hours in 24 slots: Saturday 8 PM to Sunday 8 PM');
  assert.equal(spring[23].at, '2027-03-15T00:00:00Z', 'Sunday 8 PM is EDT');
});

// ---------------------------------------------------------------------------
// 3. NO ZONE: THE ONE OFFSET, EXACTLY AS BEFORE
// ---------------------------------------------------------------------------

test('a venue with no zone keeps the fixed offset and the old walk, timestamp for timestamp', async () => {
  for (const tz of ['UTC', NY]) {
    await inTz(tz, () => {
      for (const noZone of [bar({ timeZone: undefined }), bar({ timeZone: null }), bar({ timeZone: 'Not/AZone' })]) {
        const base = wall(2026, 11, 1, 0);
        const slots = I.forecastSlots(noZone, base, 4, Date.parse(FALL_NOW));
        assert.deepEqual(slots.map((s) => label(s.ts)), ['12 AM', '1 AM', '2 AM', '3 AM'], tz);
        // The old strip: consecutive wall-clock hours, each converted with the
        // one offset Google gave (-240 all night, so everything after 2 AM is
        // an hour early; that is the degradation a zone-less venue keeps).
        assert.deepEqual(slots.map((s) => iso(s.instantMs)), [
          '2026-11-01T04:00:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z',
        ], tz);
        slots.forEach((s) => {
          assert.equal(s.instantMs, I.trueEventInstant(s.ts, -240).getTime(), 'the same conversion as before');
        });
      }
    });
  }
  // On Railway the no-zone slot timestamps are the old `base + i hours`.
  const base = wall(2026, 11, 1, 0);
  const slots = I.forecastSlots(bar({ timeZone: null }), base, 4, Date.parse(FALL_NOW));
  slots.forEach((s, i) => assert.equal(s.ts.getTime(), base.getTime() + i * HOUR));
});

test('a single timestamp\'s event instant uses the zone when there is one, and the offset otherwise', () => {
  const sunday8pm = wall(2026, 11, 1, 20);
  assert.equal(iso(I.venueInstant(sunday8pm, bar()).getTime()), '2026-11-02T01:00:00Z', 'Sunday evening is EST');
  assert.equal(iso(I.venueInstant(sunday8pm, bar({ timeZone: null })).getTime()), '2026-11-02T00:00:00Z',
    'the one offset from Saturday puts it an hour early, which is the old behaviour a zone-less venue keeps');
  const saturday8pm = wall(2026, 10, 31, 20);
  assert.equal(iso(I.venueInstant(saturday8pm, bar()).getTime()), '2026-11-01T00:00:00Z');
  assert.equal(iso(I.venueInstant(saturday8pm, bar({ timeZone: null })).getTime()), '2026-11-01T00:00:00Z',
    'before the change the offset was right, and both agree');
  const march8pm = wall(2027, 3, 14, 20);
  assert.equal(iso(I.venueInstant(march8pm, bar({ utcOffsetMinutes: -300 })).getTime()), '2027-03-15T00:00:00Z');
  assert.equal(iso(I.venueInstant(march8pm, bar({ utcOffsetMinutes: -300, timeZone: null })).getTime()),
    '2027-03-15T01:00:00Z');
});

// ---------------------------------------------------------------------------
// 4. END TO END: predictHourlyForecast WITH THE CLOCK FROZEN ON THE NIGHT
// ---------------------------------------------------------------------------

// The vendor's hourly list for the night, one entry per real hour, each
// carrying the instant it describes so the slot that received it can be read.
function hourlyWeather(fromIso, hours) {
  const start = Date.parse(fromIso);
  return Array.from({ length: hours }, (_, i) => ({
    at: start + i * HOUR,
    temp: 52, humidity: 70, windSpeed: 6, isRaining: false, conditionId: 800,
    marker: iso(start + i * HOUR),
  }));
}
const LIVE = { temp: 54, humidity: 65, windSpeed: 5, isRaining: false, conditionId: 800, marker: 'live' };

// Runs one strip with the clock frozen at `nowIso` and returns each entry's
// label with the weather it was scored on. The weather is read where the rule
// engine receives it; with no baseline rows that is every slot.
async function frozenStrip(venue, nowIso, startHour, count, baseWall, wx) {
  const seen = [];
  const realScore = crowdEngine.calculateCrowdScore;
  const realHourly = weatherService.getHourlyForecast;
  mock.timers.enable({ apis: ['Date'], now: Date.parse(nowIso) });
  crowdEngine.calculateCrowdScore = (v, weather, ts) => {
    seen.push(`${label(new Date(ts))}=${weather && weather.marker}`);
    return realScore(v, weather, ts);
  };
  weatherService.getHourlyForecast = async () => wx;
  try {
    const strip = await mlPredictor.predictHourlyForecast(venue, LIVE, startHour, count, baseWall);
    return { labels: strip.map((e) => e.hour), seen, strip };
  } finally {
    crowdEngine.calculateCrowdScore = realScore;
    weatherService.getHourlyForecast = realHourly;
    mock.timers.reset();
  }
}

test('fall back, clock frozen at 12:30 AM: one 1 AM, and each slot gets its own instant\'s weather', async () => {
  const { labels, seen } = await frozenStrip(
    bar({ place_id: 'dst-e2e-fall', location: { latitude: 40.73, longitude: -73.98 } }),
    FALL_NOW, 0, 6, wall(2026, 11, 1, 0), hourlyWeather('2026-11-01T00:00:00Z', 24));
  assert.deepEqual(labels, ['12 AM', '1 AM', '2 AM', '3 AM', '4 AM', '5 AM']);
  assert.deepEqual(seen, [
    // Within 90 minutes of now the live reading wins (weatherForSlot).
    '12 AM=live',
    '1 AM=live',
    // 2 AM on the wall clock is 07:00Z. With the one offset it was matched to
    // 06:00Z, the hour the clocks went back.
    '2 AM=2026-11-01T07:00:00Z',
    '3 AM=2026-11-01T08:00:00Z',
    '4 AM=2026-11-01T09:00:00Z',
    '5 AM=2026-11-01T10:00:00Z',
  ]);
});

test('spring forward, clock frozen at 12:30 AM: no 2 AM, and 3 AM gets 3 AM\'s weather', async () => {
  const { labels, seen } = await frozenStrip(
    bar({ place_id: 'dst-e2e-spring', utcOffsetMinutes: -300, location: { latitude: 40.74, longitude: -73.97 } }),
    SPRING_NOW, 0, 6, wall(2027, 3, 14, 0), hourlyWeather('2027-03-14T00:00:00Z', 24));
  assert.deepEqual(labels, ['12 AM', '1 AM', '3 AM', '4 AM', '5 AM', '6 AM']);
  assert.deepEqual(seen, [
    '12 AM=live',
    '1 AM=live',
    '3 AM=2027-03-14T07:00:00Z',
    '4 AM=2027-03-14T08:00:00Z',
    '5 AM=2027-03-14T09:00:00Z',
    '6 AM=2027-03-14T10:00:00Z',
  ]);
});

test('a venue with no zone keeps the old weather match through the same night', async () => {
  const { labels, seen } = await frozenStrip(
    bar({ place_id: 'dst-e2e-nozone', timeZone: null, location: { latitude: 40.75, longitude: -73.96 } }),
    FALL_NOW, 0, 4, wall(2026, 11, 1, 0), hourlyWeather('2026-11-01T00:00:00Z', 24));
  assert.deepEqual(labels, ['12 AM', '1 AM', '2 AM', '3 AM']);
  assert.deepEqual(seen, ['12 AM=live', '1 AM=live', '2 AM=2026-11-01T06:00:00Z', '3 AM=2026-11-01T07:00:00Z']);
});

// The Ticketmaster windows the strip asks for. `rangeOk` false makes the one
// range prefetch fail, so every slot asks for its own hour and its window can
// be read; true lets the prefetch answer for the whole strip.
async function eventWindows(venue, nowIso, startHour, count, baseWall, rangeOk) {
  const calls = [];
  const realFetch = global.fetch;
  process.env.TICKETMASTER_API_KEY = 'dst-test-key';
  I.__resetEventBudget();
  global.fetch = async (url) => {
    const u = new URL(String(url));
    const range = u.searchParams.get('size') === '200';
    calls.push({ range, start: u.searchParams.get('startDateTime'), end: u.searchParams.get('endDateTime') });
    if (range && !rangeOk) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ _embedded: { events: [] } }) };
  };
  try {
    const { labels } = await frozenStrip(venue, nowIso, startHour, count, baseWall, null);
    return { labels, calls };
  } finally {
    global.fetch = realFetch;
    delete process.env.TICKETMASTER_API_KEY;
    I.__resetEventBudget();
  }
}

test('each slot\'s event window is read at the slot\'s real hour', async () => {
  const { labels, calls } = await eventWindows(
    bar({ place_id: 'dst-events-fall', location: { latitude: 40.76, longitude: -73.95 } }),
    FALL_NOW, 0, 5, wall(2026, 11, 1, 0), false);
  assert.deepEqual(labels, ['12 AM', '1 AM', '2 AM', '3 AM', '4 AM']);
  const perSlot = calls.filter((c) => !c.range).map((c) => c.end);
  // The window closes at the end of the slot's own UTC hour. 2 AM closes at
  // 07:59:59Z; the one offset from Saturday closed it at 06:59:59Z.
  assert.deepEqual(perSlot, [
    '2026-11-01T04:59:59Z', '2026-11-01T05:59:59Z', '2026-11-01T07:59:59Z',
    '2026-11-01T08:59:59Z', '2026-11-01T09:59:59Z',
  ]);
});

test('the one range prefetch covers every slot, including the real hour the autumn change adds', async () => {
  const { calls } = await eventWindows(
    bar({ place_id: 'dst-events-range', location: { latitude: 40.77, longitude: -73.94 } }),
    FALL_NOW, 0, 6, wall(2026, 11, 1, 0), true);
  assert.equal(calls.length, 1, 'one Ticketmaster call for the whole strip, every slot answered from it');
  // First slot 04:00Z less the three-hour lookback; last slot 10:00Z (5 AM
  // EST). A range of "6 hours from the first slot" would have stopped at 09:59.
  assert.equal(calls[0].start, '2026-11-01T01:00:00Z');
  assert.equal(calls[0].end, '2026-11-01T10:59:59Z');
});

test('a single prediction on the far side of the change reads its event window at the right hour', async () => {
  const calls = [];
  const realFetch = global.fetch;
  process.env.TICKETMASTER_API_KEY = 'dst-test-key';
  I.__resetEventBudget();
  global.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.searchParams.get('endDateTime'));
    return { ok: true, status: 200, json: async () => ({ _embedded: { events: [] } }) };
  };
  // Saturday afternoon, asking about Sunday 8 PM.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T18:00:00Z') });
  try {
    await mlPredictor.predictBusyness(
      bar({ place_id: 'dst-single', location: { latitude: 40.78, longitude: -73.93 } }), LIVE, wall(2026, 11, 1, 20));
    await mlPredictor.predictBusyness(
      bar({ place_id: 'dst-single-nozone', timeZone: null, location: { latitude: 40.79, longitude: -73.92 } }),
      LIVE, wall(2026, 11, 1, 20));
  } finally {
    mock.timers.reset();
    global.fetch = realFetch;
    delete process.env.TICKETMASTER_API_KEY;
    I.__resetEventBudget();
  }
  assert.deepEqual(calls, ['2026-11-02T01:59:59Z', '2026-11-02T00:59:59Z'],
    'with the zone, Sunday 8 PM is 01:00Z; with only Saturday\'s offset it stays an hour early');
});

// ---------------------------------------------------------------------------
// 5. THE CLOCK "NOW", AND WALKING A STRIP THAT HAS NO 2 AM
// ---------------------------------------------------------------------------

test('the venue clock reads the zone, so a payload cached across the change is not an hour off', () => {
  // Google said -240 before 2 AM; the payload is still cached at 1:30 AM EST.
  const secondOneAm = new Date('2026-11-01T06:30:00Z');
  assert.equal(crowdEngine.venueLocalNow(-240, secondOneAm).hour, 2, 'the cached offset alone says 2 AM');
  const zoned = crowdEngine.venueLocalNow(-240, secondOneAm, NY);
  assert.deepEqual(zoned, { hour: 1, day: 0, utcOffsetMinutes: -300 });

  // March: a cached -300 at 3:30 AM EDT names an hour that does not exist.
  const afterJump = new Date('2027-03-14T07:30:00Z');
  assert.equal(crowdEngine.venueLocalNow(-300, afterJump).hour, 2);
  assert.deepEqual(crowdEngine.venueLocalNow(-300, afterJump, NY), { hour: 3, day: 0, utcOffsetMinutes: -240 });

  // No usable zone: the offset, as before, and it says which offset it used.
  assert.deepEqual(crowdEngine.venueLocalNow(-240, secondOneAm, 'Not/AZone'), { hour: 2, day: 0, utcOffsetMinutes: -240 });
  assert.equal(crowdEngine.venueLocalNow(null, secondOneAm, null), null);
  // A zone with no offset is still a clock.
  assert.equal(crowdEngine.venueLocalNow(null, secondOneAm, NY).hour, 1);
});

// Sunday 2027-03-14 from 1 AM, 24 entries: 1 AM, then 3 AM through 11 PM, then
// Monday's 12 AM and 1 AM. Entry 22 is Monday.
function springStrip(scoreFor) {
  const hours = [1, ...Array.from({ length: 21 }, (_, i) => i + 3), 0, 1];
  return hours.map((h, i) => ({
    hour: `${h === 0 ? 12 : h > 12 ? h - 12 : h} ${h >= 12 ? 'PM' : 'AM'}`,
    score: scoreFor(i),
    baselineScore: null,
  }));
}

test('stripClock reads each entry\'s hour and day off its label, gap included', () => {
  const strip = springStrip(() => 50);
  const clock = crowdEngine.stripClock(strip);
  assert.deepEqual(clock[0], { hour: 1, dayOffset: 0 });
  assert.deepEqual(clock[1], { hour: 3, dayOffset: 0 }, 'no 2 AM entry, and 3 AM is still Sunday');
  assert.deepEqual(clock[21], { hour: 23, dayOffset: 0 });
  assert.deepEqual(clock[22], { hour: 0, dayOffset: 1 }, 'Monday 12 AM; "start + index" called this Sunday 11 PM');
  assert.deepEqual(clock[23], { hour: 1, dayOffset: 1 });
  // Labels it cannot read fall back to the old index arithmetic from the
  // hour the caller started the strip at.
  const opaque = [{ hour: '20' }, { hour: '21' }, { hour: '22' }, { hour: '23' }, { hour: '0' }];
  assert.deepEqual(crowdEngine.stripClock(opaque, 22).map((c) => [c.hour, c.dayOffset]),
    [[22, 0], [23, 0], [0, 1], [1, 1], [2, 1]]);
});

test('the best-time line does not send people to Monday\'s 12 AM as if it were Sunday\'s', () => {
  // Open all Sunday, shut all Monday. The quietest entry is Monday's 12 AM.
  const venue = {
    types: ['bar'],
    hoursByDay: { 0: [{ open: 0, close: 24, closeMinute: 0 }], 1: [] },
  };
  const strip = springStrip((i) => (i === 22 ? 10 : 60));
  const best = crowdEngine.recommendBestTime(strip, venue, null, null, true, {
    currentHour: 1, currentDay: 0, currentScore: 60,
  });
  assert.notEqual(best.index, 22, 'Monday is shut; counted by index it looked like Sunday and got named');
  const peak = crowdEngine.findPeakTime(springStrip((i) => (i === 22 ? 95 : 40)), venue, { startDay: 0 });
  assert.notEqual(peak.startIdx, 22, 'Monday 12 AM is closed and cannot be Sunday\'s peak');
});

// ---------------------------------------------------------------------------
// 6. THE ZONE REACHES THE VENUE SHAPE, AND IT COSTS NOTHING
// ---------------------------------------------------------------------------

test('the crowd card and the public demo carry Google\'s zone into the venue', async () => {
  const place = {
    id: 'ChIJdstTestPlace01',
    displayName: { text: 'Clock Change Bar' },
    rating: 4.3, userRatingCount: 500, priceLevel: 'PRICE_LEVEL_MODERATE',
    types: ['bar'], location: { latitude: 40.72, longitude: -73.99 },
    currentOpeningHours: { openNow: true, periods: [] },
    utcOffsetMinutes: -240,
    timeZone: { id: NY },
  };
  assert.equal(toVenueShape(place, null).timeZone, NY);
  assert.equal(toVenueShape({ ...place, timeZone: undefined }, null).timeZone, null,
    'a payload without the field shapes to null and the offset is used');

  placeDetailsCache.__test.reset();
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => place });
  try {
    const venue = await fetchVenueFromGoogle(place.id, 6);
    assert.equal(venue.timeZone, NY);
    assert.equal(venue.utcOffsetMinutes, -240, 'the offset still rides beside it');
  } finally {
    global.fetch = realFetch;
    placeDetailsCache.__test.reset();
  }
});

test('every mask that feeds the crowd model asks for timeZone, and only on masks it rides free on', () => {
  const BACKEND = path.join(__dirname, '..');
  const src = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8').replace(/\r\n/g, '\n');
  const masks = [
    ['services/placeDetailsCache.js', placeDetailsCache.PLACE_DETAILS_FIELD_MASK],
  ];
  for (const rel of ['routes/crowd.js', 'routes/ai.js', 'routes/venueDashboard.js', 'routes/badge.js']) {
    for (const m of src(rel).matchAll(/'X-Goog-FieldMask': '([^']+)'/g)) masks.push([rel, m[1]]);
  }
  const demo = src('routes/publicCrowd.js').match(/const PLACE_FIELDS = '([^']+)'/);
  assert.ok(demo, 'the public demo mask moved; this guard is reading nothing');
  masks.push(['routes/publicCrowd.js', demo[1]]);

  const fields = (mask) => mask.split(',').map((f) => f.trim().replace(/^places\./, ''));
  // The masks whose venue is scored on its own clock server-side: every one
  // that asks for the offset, plus the badge, which scores through the
  // predictor and used to estimate its clock from the longitude. (Birdie's
  // search mask is text for the model, and the crowd tool refetches details.)
  const feeding = masks.filter(([rel, mask]) =>
    fields(mask).includes('utcOffsetMinutes') || rel === 'routes/badge.js');
  assert.equal(feeding.length, 7,
    `expected the details cache, crowd alternatives, Birdie details, the demo, the dashboard's two and the badge; found ${feeding.map(([r]) => r).join(', ')}`);
  for (const [rel, mask] of feeding) {
    assert.ok(fields(mask).includes('timeZone'), `${rel}: ${mask} does not ask for timeZone`);
  }
  // timeZone is Pro. Every mask that carries it also carries an Enterprise
  // field (rating, userRatingCount, priceLevel, currentOpeningHours), so the
  // request is billed at Enterprise either way and the zone adds nothing.
  for (const [rel, mask] of masks.filter(([, m]) => fields(m).includes('timeZone'))) {
    assert.ok(['rating', 'userRatingCount', 'priceLevel', 'currentOpeningHours'].some((f) => fields(mask).includes(f)),
      `${rel}: timeZone on a mask with no Enterprise field would raise its price`);
  }
});
