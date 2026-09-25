'use strict';
// ---------------------------------------------------------------------------
// The realtime collector's shared Ticketmaster query, on a SIMULATED clock.
// No database, no network.
//
// WHY THIS EXISTS. Every stored reading used to ask Ticketmaster for the events
// near its venue, one request per row. With the sweep reaching every venue
// each hour that runs past Discovery's free 5,000 a day, and past the quota
// every lookup fails and the rows record events_observed=false. So the
// collector now asks once per 0.01 degree cell per hour, with a query wide
// enough to hold every member venue's own 2 km disk, and works out each
// venue's answer from that list with eventService's own code.
//
// What is pinned below:
//   * the shared radius is DERIVED (2 km plus the cell's half-diagonal, in
//     Discovery's whole km) and covers every member's disk, while the naive
//     design, a 2 km query recentred on the cell, provably loses events;
//   * venues in one cell and hour share ONE request, including requests made
//     at the same moment, and each venue still gets exactly the answer its
//     own request would have produced, the twenty-event page cap included;
//   * a new hour is a new request, because Discovery's time window moves;
//   * a failed shared request is NEVER kept as an answer, empty or otherwise:
//     the cell's venues ask for themselves for the rest of the hour, so a row
//     records a failed lookup exactly when its own request fails, as before;
//   * a list that is incomplete, or holds an event without coordinates, is
//     never shared: those venues are asked one by one, with exactly the old
//     request;
//   * through a whole overlapped sweep, requests collapse to one per cell.
//
// The fake Discovery applies the real query's rules (radius, the UTC-hour time
// window eventService builds, date order, the page cap and the total) to a
// fixed set of events, and each venue's reference answer is computed the way
// getNearestEvent computes it today: its own request, then
// eventService.nearestEventFromAnswers.
//
// HOW TO RUN
//   cd backend && node --test __tests__/collectRealtimeEventCache.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');

// Nothing here may reach a real service. collectRealtime.js loads backend/.env,
// and dotenv never overwrites a variable that is already set: so a database URL
// on a port nothing listens on, and EMPTY keys, which the real fetchers treat
// as "cannot answer" without making a request.
process.env.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:1/none';
process.env.PGSSLMODE = 'disable';
process.env.BESTTIME_API_KEY = '';
process.env.TICKETMASTER_API_KEY = '';
process.env.SEATGEEK_CLIENT_ID = '';

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}
const realBestTime = require('../scripts/ml/bestTimeService');
stubModule('../scripts/ml/bestTimeService', {
  ...realBestTime,
  fetchLiveBusyness: async () => { throw new Error('this suite must inject fetchLive'); },
});
stubModule('../services/weatherService', {
  getWeather: async () => { throw new Error('this suite must inject weatherFor'); },
  getForecast: async () => [],
});

// The REAL event module: its answer logic is what every venue must still get.
const events = require('../scripts/ml/eventService');
const {
  createEventLookup, sharedEventRadiusKm, cellHalfDiagonalKm, EVENT_CELL_DEG, EVENT_SHARED_PAGE,
  sweepVenues, LABEL_LIVE,
} = require('../scripts/ml/collectRealtime');
const { virtualClock } = require('./helpers/virtualClock');

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
// 19:10 in Philadelphia; Discovery's window for this hour runs 20:00 to 23:59:59 UTC.
const T0 = Date.UTC(2026, 8, 25, 23, 10, 0);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Deterministic pseudo-random numbers, so a failure reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A point `km` from (lat, lon) on bearing `deg`, on the same sphere
// eventService.distanceKm uses.
function offset(lat, lon, km, deg) {
  const R = 6371;
  const d = km / R;
  const b = (deg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: (p2 * 180) / Math.PI, lon: (l2 * 180) / Math.PI };
}

const cellOf = (lat, lon) => [Math.floor(lat / EVENT_CELL_DEG), Math.floor(lon / EVENT_CELL_DEG)];
const centreOf = ([cLat, cLon]) => ({ lat: (cLat + 0.5) * EVENT_CELL_DEG, lon: (cLon + 0.5) * EVENT_CELL_DEG });

// Venues scattered inside one cell.
function venuesIn(cell, n, random, firstId) {
  return Array.from({ length: n }, (_, i) => ({
    id: firstId + i,
    name: `venue ${firstId + i}`,
    latitude: (cell[0] + 0.02 + 0.96 * random()) * EVENT_CELL_DEG,
    longitude: (cell[1] + 0.02 + 0.96 * random()) * EVENT_CELL_DEG,
  }));
}

// An event somewhere, starting at `startMs`. `shown: false` is an event
// Discovery places (it filters on the location it holds) but whose payload
// carries no coordinates.
function event(name, where, startMs, { shown = true, size = null } = {}) {
  return { name, type: 'music', where, startTime: iso(startMs), size, shown };
}

// A fake Discovery with the real query's rules.
function discovery(clock, universe, { latencyMs = 250, fail = () => false } = {}) {
  const calls = [];
  const fetchPage = async (lat, lon, radiusKm, at, size = events.TM_PAGE_SIZE) => {
    const call = { lat, lon, radiusKm, size, hour: Math.floor(at.getTime() / HOUR) };
    calls.push(call);
    await clock.pause(latencyMs);
    if (fail(call, calls.length - 1)) return null;
    // eventService's window: from three hours before the lookup's UTC hour to
    // the last second of it, inclusive.
    const open = (call.hour - 3) * HOUR;
    const close = (call.hour + 1) * HOUR - 1000;
    const matched = universe
      .filter((e) => events.distanceKm(lat, lon, e.where.lat, e.where.lon) <= radiusKm)
      .filter((e) => { const s = Date.parse(e.startTime); return s >= open && s <= close; })
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.name.localeCompare(b.name));
    return {
      events: matched.slice(0, size).map((e) => ({
        name: e.name,
        type: e.type,
        lat: e.shown ? e.where.lat : 0,
        lon: e.shown ? e.where.lon : 0,
        startTime: e.startTime,
        size: e.size,
      })),
      total: matched.length,
    };
  };
  return { fetchPage, calls };
}

const noSeatGeek = async () => null; // SEATGEEK_CLIENT_ID is unset everywhere

// What the per-venue path gives today: the venue's own request, then the
// answer. `ownRequest` is a separate fake, so the reference never counts
// against the shared one.
async function reference(ownRequest, lat, lon, at) {
  const page = await ownRequest.fetchPage(lat, lon, events.NEARBY_KM, at);
  return events.nearestEventFromAnswers(page ? page.events : null, null, lat, lon, at);
}

function lookupWith(clock, request, extra = {}) {
  return createEventLookup({
    fetchPage: request.fetchPage, fetchSeatGeek: noSeatGeek, now: clock.now, ...extra,
  });
}

// A busy centre: 25 events within a kilometre of the cell's centre (so every
// venue in the cell has more than twenty within its 2 km, and the per-venue
// page cap is exercised), a ring between 2 and 2.8 km (inside the shared disk,
// inside some venues' 2 km and not others'), a few beyond the shared disk,
// and a few outside the time window.
function busyUniverse(centre, random) {
  const out = [];
  const windowOpen = Date.UTC(2026, 8, 25, 20, 0, 0);
  for (let i = 0; i < 25; i++) {
    out.push(event(`core ${i}`, offset(centre.lat, centre.lon, 0.2 + 0.8 * random(), 360 * random()),
      windowOpen + (i * 7 + 3) * MINUTE, { size: 500 + i }));
  }
  for (let i = 0; i < 12; i++) {
    out.push(event(`ring ${i}`, offset(centre.lat, centre.lon, 2.0 + 0.8 * random(), 360 * random()),
      windowOpen + (i * 11 + 5) * MINUTE));
  }
  for (let i = 0; i < 4; i++) {
    out.push(event(`far ${i}`, offset(centre.lat, centre.lon, 3.5 + random(), 360 * random()), windowOpen + i * MINUTE));
  }
  out.push(event('too early', offset(centre.lat, centre.lon, 0.3, 10), windowOpen - 30 * MINUTE));
  out.push(event('next hour', offset(centre.lat, centre.lon, 0.3, 190), windowOpen + 4 * HOUR + 30 * MINUTE));
  return out;
}

// ===========================================================================
// 1. The derivation
// ===========================================================================

test('the shared radius is derived from the lookup radius and the cell, and holds every member venue\'s disk', () => {
  assert.strictEqual(events.NEARBY_KM, 2, 'the per-venue lookup radius this derivation starts from');
  assert.strictEqual(EVENT_CELL_DEG, 0.01);
  const h = cellHalfDiagonalKm(EVENT_CELL_DEG);
  assert.ok(h > 0.78 && h < 0.79, `the widest 0.01 degree cell is ${h} km centre to corner`);
  assert.strictEqual(sharedEventRadiusKm(events.NEARBY_KM), 3);
  // A cell too wide for a 3 km query is refused the 3 km radius, not squeezed into it.
  assert.strictEqual(sharedEventRadiusKm(events.NEARBY_KM, 0.02), 4);
  // What the collector builds with no arguments, against the real event
  // module: the shared mode, at the derived radius. (Nothing is asked here.)
  const production = createEventLookup();
  assert.strictEqual(production.shared, true);
  assert.strictEqual(production.radiusKm, 3);

  // Any venue in any cell, any event within 2 km of it: inside the shared
  // disk, with the margin to spare, from the equator to 60 degrees north.
  const random = rng(11);
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const cell = [Math.floor((60 * random()) / EVENT_CELL_DEG), Math.floor((-180 + 360 * random()) / EVENT_CELL_DEG)];
    const venue = { lat: (cell[0] + random()) * EVENT_CELL_DEG, lon: (cell[1] + random()) * EVENT_CELL_DEG };
    const ev = offset(venue.lat, venue.lon, 2 * random(), 360 * random());
    const c = centreOf(cell);
    worst = Math.max(worst, events.distanceKm(c.lat, c.lon, ev.lat, ev.lon));
  }
  assert.ok(worst <= sharedEventRadiusKm(events.NEARBY_KM) - 0.1, `an event came ${worst} km from its cell centre`);
});

test('recentring a 2 km query on the cell is not safe: it loses events a venue\'s own query finds', () => {
  // A venue near a corner of a Philadelphia cell, and an event 1.4 km from it
  // on the side away from the cell's centre.
  const cell = [3995, -7517];
  const c = centreOf(cell);
  const venue = { lat: (cell[0] + 0.98) * EVENT_CELL_DEG, lon: (cell[1] + 0.98) * EVENT_CELL_DEG };
  // The bearing away from the centre, in kilometres rather than raw degrees:
  // a degree of longitude is shorter than one of latitude this far north.
  const away = (Math.atan2((venue.lon - c.lon) * Math.cos((c.lat * Math.PI) / 180), venue.lat - c.lat) * 180) / Math.PI;
  const ev = offset(venue.lat, venue.lon, 1.4, away);
  assert.ok(events.distanceKm(venue.lat, venue.lon, ev.lat, ev.lon) < events.NEARBY_KM, 'the venue\'s own query finds it');
  assert.ok(events.distanceKm(c.lat, c.lon, ev.lat, ev.lon) > events.NEARBY_KM, 'a 2 km query from the centre misses it');
  assert.ok(events.distanceKm(c.lat, c.lon, ev.lat, ev.lon) <= sharedEventRadiusKm(events.NEARBY_KM), 'the 3 km one does not');
});

// ===========================================================================
// 2. One request per cell, and every venue's own answer
// ===========================================================================

test('venues in one cell share one request, and each gets exactly the answer its own request would give', async () => {
  const random = rng(5);
  const cellA = [3995, -7517]; // Center City
  const cellB = [3994, -7516];
  const cellC = [4060, -7548]; // Allentown
  const venues = [
    ...venuesIn(cellA, 12, random, 1), ...venuesIn(cellB, 5, random, 101), ...venuesIn(cellC, 1, random, 201),
  ];
  const universe = [
    ...busyUniverse(centreOf(cellA), random),
    event('allentown show', offset(centreOf(cellC).lat, centreOf(cellC).lon, 0.9, 45), Date.UTC(2026, 8, 25, 22, 0, 0)),
  ];
  const clock = virtualClock(T0);
  const shared = discovery(clock, universe);
  const own = discovery(clock, universe);
  const lookup = lookupWith(clock, shared);
  const answers = [];
  const expected = [];
  const fullOwnPages = [];
  await clock.run((async () => {
    for (const v of venues) {
      const at = new Date(clock.now());
      answers.push(await lookup.lookup(v.latitude, v.longitude));
      expected.push(await reference(own, v.latitude, v.longitude, at));
      const ownPage = await own.fetchPage(v.latitude, v.longitude, events.NEARBY_KM, at);
      fullOwnPages.push(ownPage.total > events.TM_PAGE_SIZE);
      await clock.pause(1000);
    }
  })());

  // Three cells, three requests: one each, at the cell's centre, 3 km wide,
  // asking for the shared page.
  assert.strictEqual(shared.calls.length, 3, `${shared.calls.length} Ticketmaster requests for three cells`);
  for (const call of shared.calls) {
    assert.strictEqual(call.radiusKm, 3);
    assert.strictEqual(call.size, EVENT_SHARED_PAGE);
    const cell = cellOf(call.lat, call.lon);
    const c = centreOf(cell);
    assert.ok(Math.abs(call.lat - c.lat) < 1e-9 && Math.abs(call.lon - c.lon) < 1e-9, 'the request is not at the cell centre');
  }
  assert.deepStrictEqual(lookup.stats, { lookups: 18, sharedCalls: 3, perVenueCalls: 0, failedSharedCalls: 0 });

  // Every venue: exactly its own answer.
  venues.forEach((v, i) => assert.deepStrictEqual(answers[i], expected[i], `${v.name} got a different answer than its own request gives`));
  // The fixture really exercised what matters: the per-venue page cap bit,
  // and venues in one cell got different answers from one list.
  assert.ok(fullOwnPages.slice(0, 12).every(Boolean), 'no venue had more than twenty events within its 2 km');
  const distances = new Set(answers.slice(0, 12).map((a) => a.event_distance_km));
  assert.ok(distances.size > 3, 'the venues in one cell did not get their own answers');
  assert.strictEqual(answers[17].event_nearby, true, 'the Allentown venue sees its show');
});

test('venues asking at the same moment share the one request already in flight', async () => {
  const random = rng(9);
  const cell = [3995, -7517];
  const venues = venuesIn(cell, 6, random, 1);
  const universe = busyUniverse(centreOf(cell), random);
  const clock = virtualClock(T0);
  const shared = discovery(clock, universe, { latencyMs: 800 });
  const own = discovery(clock, universe);
  const lookup = lookupWith(clock, shared);
  const at = new Date(clock.now());
  const answers = await clock.run(Promise.all(venues.map((v) => lookup.lookup(v.latitude, v.longitude))));
  assert.strictEqual(shared.calls.length, 1);
  const expected = await clock.run(Promise.all(venues.map((v) => reference(own, v.latitude, v.longitude, at))));
  assert.deepStrictEqual(answers, expected);
});

test('a new hour is a new request, because Discovery\'s window moves with it', async () => {
  const cell = [3995, -7517];
  const c = centreOf(cell);
  const venue = { lat: c.lat + 0.001, lon: c.lon - 0.001 };
  // Starts at 22:30 UTC: inside the 22:00 window (19:00 to 22:59:59), outside
  // the 21:00 one (18:00 to 21:59:59).
  const universe = [event('late show', offset(c.lat, c.lon, 0.5, 30), Date.UTC(2026, 8, 25, 22, 30, 0))];
  const clock = virtualClock(Date.UTC(2026, 8, 25, 21, 59, 59, 500));
  const shared = discovery(clock, universe, { latencyMs: 100 });
  const lookup = lookupWith(clock, shared);
  const [before, after] = await clock.run((async () => {
    const first = await lookup.lookup(venue.lat, venue.lon); // asked at 21:59:59.5
    await clock.pause(800); // 22:00:00.4
    return [first, await lookup.lookup(venue.lat, venue.lon)];
  })());
  assert.strictEqual(shared.calls.length, 2, 'the 21:00 list was reused at 22:00');
  assert.deepStrictEqual(shared.calls.map((c2) => c2.hour % 24), [21, 22]);
  assert.strictEqual(before.event_nearby, false);
  assert.strictEqual(after.event_nearby, true);
});

// ===========================================================================
// 3. A failure is never an empty answer
// ===========================================================================

test('a failed shared request is never kept as an answer: its rows ask for themselves, as before', async () => {
  const cell = [3995, -7517];
  const c = centreOf(cell);
  const universe = [event('big night', offset(c.lat, c.lon, 0.3, 120), Date.UTC(2026, 8, 25, 21, 0, 0), { size: 20000 })];
  const venues = venuesIn(cell, 4, rng(3), 1);
  const clock = virtualClock(T0);
  // The shared request fails (a timeout, a 5xx, a page size Discovery
  // refuses); each venue's own request answers.
  const shared = discovery(clock, universe, { latencyMs: 600, fail: (call) => call.radiusKm !== events.NEARBY_KM });
  const lookup = lookupWith(clock, shared);

  const answers = await clock.run((async () => {
    // Three venues were waiting on the request that failed; the fourth asks
    // after it.
    const waiting = await Promise.all(venues.slice(0, 3).map((v) => lookup.lookup(v.latitude, v.longitude)));
    await clock.pause(1000);
    return [...waiting, await lookup.lookup(venues[3].latitude, venues[3].longitude)];
  })());

  // No row was handed the failure, and none was handed "no events": each got
  // the answer its own request gives.
  for (const a of answers) {
    assert.strictEqual(a.observed, true, 'a row was handed the shared failure');
    assert.strictEqual(a.event_nearby, true, 'the failure was reused as an empty answer');
    assert.strictEqual(a.event_size, 20000);
  }
  // One shared attempt for the hour, then the old request per venue.
  assert.strictEqual(shared.calls.filter((call) => call.radiusKm === 3).length, 1,
    'the failed shared request was retried within the hour');
  assert.deepStrictEqual(lookup.stats, { lookups: 4, sharedCalls: 1, perVenueCalls: 4, failedSharedCalls: 1 });
});

test('when Ticketmaster answers nobody, every row records a failed lookup, never a quiet night', async () => {
  const venues = venuesIn([3995, -7517], 3, rng(4), 1);
  const clock = virtualClock(T0);
  // The quota is spent: every request fails, shared or not.
  const shared = discovery(clock, [], { fail: () => true });
  const lookup = lookupWith(clock, shared);
  const answers = await clock.run(Promise.all(venues.map((v) => lookup.lookup(v.latitude, v.longitude))));
  // Exactly what a failed per-venue request always recorded.
  const failedPerVenue = events.nearestEventFromAnswers(null, null, venues[0].latitude, venues[0].longitude, new Date(T0));
  for (const a of answers) {
    assert.deepStrictEqual(a, failedPerVenue);
    assert.strictEqual(a.observed, false);
    assert.strictEqual(a.reason, 'lookup_failed');
  }
  // What a failing shared request costs: one per cell per hour, on top.
  assert.strictEqual(shared.calls.length, 1 + venues.length);
});

test('falling back lasts the hour: the next hour tries the cell\'s shared request again', async () => {
  const cell = [3995, -7517];
  const c = centreOf(cell);
  const universe = [event('after midnight', offset(c.lat, c.lon, 0.4, 300), Date.UTC(2026, 8, 26, 0, 20, 0))];
  const venues = venuesIn(cell, 3, rng(8), 1);
  const clock = virtualClock(Date.UTC(2026, 8, 25, 23, 58, 0));
  // Only the first shared request fails.
  let sharedSeen = 0;
  const shared = discovery(clock, universe, {
    latencyMs: 200,
    fail: (call) => call.radiusKm !== events.NEARBY_KM && sharedSeen++ === 0,
  });
  const lookup = lookupWith(clock, shared);
  await clock.run((async () => {
    await lookup.lookup(venues[0].latitude, venues[0].longitude); // 23:58, the shared request fails
    await clock.pause(5 * MINUTE); // 00:03, a new hour
    await lookup.lookup(venues[1].latitude, venues[1].longitude);
    await lookup.lookup(venues[2].latitude, venues[2].longitude);
  })());
  const sharedCalls = shared.calls.filter((call) => call.radiusKm === 3);
  assert.deepStrictEqual(sharedCalls.map((call) => call.hour % 24), [23, 0]);
  // 23:58: the failed shared request and one per-venue request. 00:03: one
  // shared request serving both venues.
  assert.deepStrictEqual(lookup.stats, { lookups: 3, sharedCalls: 2, perVenueCalls: 1, failedSharedCalls: 1 });
});

// ===========================================================================
// 4. What is never shared
// ===========================================================================

test('an incomplete shared list is not shared: each venue makes exactly the old request', async () => {
  const random = rng(21);
  const cell = [3995, -7517];
  const venues = venuesIn(cell, 5, random, 1);
  const universe = busyUniverse(centreOf(cell), random); // about forty events in the shared disk
  const clock = virtualClock(T0);
  const shared = discovery(clock, universe);
  const own = discovery(clock, universe);
  // A shared page smaller than the cell's events, so Discovery's total says
  // the list is cut off.
  const lookup = lookupWith(clock, shared, { sharedPage: 10 });
  const answers = [];
  const expected = [];
  await clock.run((async () => {
    for (const v of venues) {
      const at = new Date(clock.now());
      answers.push(await lookup.lookup(v.latitude, v.longitude));
      expected.push(await reference(own, v.latitude, v.longitude, at));
    }
  })());
  assert.deepStrictEqual(answers, expected);
  // One shared request, found incomplete once, then the old request per venue:
  // the venue's own point, 2 km, the default twenty-event page.
  assert.strictEqual(shared.calls.length, 1 + venues.length);
  assert.deepStrictEqual(shared.calls.slice(1).map((c) => [c.lat, c.lon, c.radiusKm, c.size]),
    venues.map((v) => [v.latitude, v.longitude, events.NEARBY_KM, events.TM_PAGE_SIZE]));
  assert.deepStrictEqual(lookup.stats, { lookups: 5, sharedCalls: 1, perVenueCalls: 5, failedSharedCalls: 0 });
});

test('a list holding an event without coordinates is not shared, so that reason is still each venue\'s own', async () => {
  const cell = [3995, -7517];
  const c = centreOf(cell);
  // Venue A's own 2 km holds only an event Discovery cannot place for us.
  // Venue B, across the cell, also has a placeable event 1.5 km out, which is
  // more than 2 km from A.
  const venueA = { lat: (cell[0] + 0.05) * EVENT_CELL_DEG, lon: (cell[1] + 0.05) * EVENT_CELL_DEG };
  const venueB = { lat: (cell[0] + 0.95) * EVENT_CELL_DEG, lon: (cell[1] + 0.95) * EVENT_CELL_DEG };
  const universe = [
    event('no coordinates', offset(venueA.lat, venueA.lon, 0.2, 225), Date.UTC(2026, 8, 25, 21, 0, 0), { shown: false }),
    event('placeable', offset(venueB.lat, venueB.lon, 1.5, 45), Date.UTC(2026, 8, 25, 21, 30, 0)),
  ];
  const placeable = universe[1].where;
  assert.ok(events.distanceKm(venueA.lat, venueA.lon, placeable.lat, placeable.lon) > events.NEARBY_KM);
  assert.ok(events.distanceKm(c.lat, c.lon, placeable.lat, placeable.lon) < sharedEventRadiusKm(events.NEARBY_KM),
    'the fixture must put both events inside the shared query');
  const clock = virtualClock(T0);
  const shared = discovery(clock, universe);
  const own = discovery(clock, universe);
  const lookup = lookupWith(clock, shared);
  const at = new Date(T0);
  const [a, b] = await clock.run((async () => [
    await lookup.lookup(venueA.lat, venueA.lon),
    await lookup.lookup(venueB.lat, venueB.lon),
  ])());
  const [refA, refB] = await clock.run((async () => [
    await reference(own, venueA.lat, venueA.lon, at),
    await reference(own, venueB.lat, venueB.lon, at),
  ])());
  assert.deepStrictEqual(a, refA);
  assert.deepStrictEqual(b, refB);
  assert.strictEqual(a.reason, 'events_without_coordinates');
  assert.strictEqual(b.event_nearby, true);
  assert.strictEqual(lookup.stats.perVenueCalls, 2);
});

test('SeatGeek is still asked per venue, with the venue\'s own point and radius', async () => {
  const clock = virtualClock(T0);
  const shared = discovery(clock, []);
  const asked = [];
  const lookup = lookupWith(clock, shared, {
    fetchSeatGeek: async (lat, lon, radiusKm) => { asked.push([lat, lon, radiusKm]); return []; },
  });
  const pts = [[39.9521, -75.1632], [39.9538, -75.1649]];
  await clock.run(Promise.all(pts.map(([lat, lon]) => lookup.lookup(lat, lon))));
  assert.deepStrictEqual(asked, pts.map(([lat, lon]) => [lat, lon, events.NEARBY_KM]));
  assert.strictEqual(shared.calls.length, 1);
});

test('an event module without the shared-query parts is asked per venue, as before', async () => {
  // In the suites that replace eventService with a double answering only
  // getNearestEvent, the missing export arrives as a default that is itself
  // undefined; null stands in for it here, because an explicit undefined would
  // select the real default instead.
  const asked = [];
  const lookup = createEventLookup({
    fetchPage: null,
    perVenue: async (lat, lon) => { asked.push([lat, lon]); return { observed: true, event_nearby: false }; },
  });
  assert.strictEqual(lookup.shared, false);
  assert.deepStrictEqual(await lookup.lookup(39.95, -75.16), { observed: true, event_nearby: false });
  assert.deepStrictEqual(asked, [[39.95, -75.16]]);
});

// ===========================================================================
// 5. Through a whole overlapped sweep
// ===========================================================================

test('through an overlapped sweep, Ticketmaster is asked once per cell and every row gets its own answer', async () => {
  const random = rng(17);
  // Four cells far enough apart that each one's shared list holds only its
  // own busy centre (about forty events, under the shared page).
  const cells = [[3995, -7517], [3985, -7525], [4005, -7505], [4060, -7548]];
  const venues = cells.flatMap((cell, k) => venuesIn(cell, 10, random, 1 + k * 100)).map((v) => ({
    ...v, besttime_venue_id: `bt_${v.id}`, city: 'philly', timezone: 'America/New_York',
  }));
  const universe = cells.flatMap((cell) => busyUniverse(centreOf(cell), random));
  const clock = virtualClock(T0);
  const shared = discovery(clock, universe, { latencyMs: 400 });
  const own = discovery(clock, universe);
  const lookup = lookupWith(clock, shared);
  const rows = new Map();
  const fetchLive = async () => {
    await clock.pause(3000);
    return { forecastedBusyness: 40, liveBusyness: 70, liveAvailable: true };
  };
  const store = async (venue) => {
    const at = new Date(clock.now());
    rows.set(venue.id, { at, answer: await lookup.lookup(venue.latitude, venue.longitude) });
    return LABEL_LIVE;
  };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  let result;
  try {
    result = await clock.run(sweepVenues([['philly', venues]], {
      store, fetchLive, weatherFor: async () => ({}), now: clock.now, pause: clock.pause,
    }));
  } finally {
    Object.assign(console, saved);
  }
  assert.strictEqual(result.totalRows, 40);
  // Forty stored readings, four cells, one hour: four requests instead of forty.
  assert.strictEqual(shared.calls.length, 4, `${shared.calls.length} Ticketmaster requests for 40 rows in 4 cells`);
  assert.deepStrictEqual(lookup.stats, { lookups: 40, sharedCalls: 4, perVenueCalls: 0, failedSharedCalls: 0 });
  for (const v of venues) {
    const row = rows.get(v.id);
    const expected = await clock.run(reference(own, v.latitude, v.longitude, row.at));
    assert.deepStrictEqual(row.answer, expected, `${v.name}'s row carries another venue's answer`);
  }
});
