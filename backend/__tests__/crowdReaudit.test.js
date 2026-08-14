// Adversarial re-audit of the crowd card + ML pipeline (venue-clock rewrite,
// weekday-offset fix, leave-one-out baseline, feature-parity gate, hours parsing).
//
// The regressions these lock were all invisible to the existing suites because
// they lived in the Google -> venue shaping step, which nothing tested:
//   1. The field mask fetched utcOffsetMinutes but the shape dropped it, so the
//      entire venue-clock path (venueLocalNow scoring + trueEventInstant event
//      window) silently reverted to the server/viewer clock in BOTH routes.
//   2. calculateCrowdScore baked a place_id-hash "variance" (±5) into the
//      displayed score — a fabricated number on the dial with no real basis.

// Must be set before requiring routes/crowd.js: API_KEY is a module-load const.
process.env.GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');

const { venueLocalNow, calculateCrowdScore } = require('../services/crowdEngine');
const { toVenueShape } = require('../routes/publicCrowd').__testables;
const { fetchVenueFromGoogle } = require('../routes/crowd').__testables;

// A Google Places (New) detail/search result. Fields are unprefixed here — the
// detail endpoint strips "places." and area-search items arrive unprefixed too.
function googlePlace(overrides = {}) {
  return {
    id: 'place-LA',
    displayName: { text: 'Sunset Bar' },
    formattedAddress: '123 Sunset Blvd',
    rating: 4.4,
    userRatingCount: 900,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    types: ['bar'],
    location: { latitude: 34.09, longitude: -118.33 },
    currentOpeningHours: {
      openNow: true,
      periods: [{ open: { day: 5, hour: 16 }, close: { day: 6, hour: 2 } }],
    },
    utcOffsetMinutes: -420, // UTC-7, Los Angeles in summer
    ...overrides,
  };
}

// --- 1. utcOffsetMinutes survives shaping (the venue-clock regression) -------

test('publicCrowd toVenueShape carries utcOffsetMinutes through to the venue', () => {
  const shape = toVenueShape(googlePlace(), null);
  assert.equal(shape.utcOffsetMinutes, -420,
    'the shape predictBusyness scores must carry the offset, or trueEventInstant is dead');
  // And it is the SAME clock the card is scored on.
  const instant = new Date('2026-08-15T02:30:00Z'); // 7:30 PM in LA
  const clock = venueLocalNow(shape.utcOffsetMinutes, instant);
  assert.ok(clock, 'a shaped venue with an offset must yield a venue clock');
  assert.equal(clock.hour, 19);
});

test('crowd.js fetchVenueFromGoogle carries utcOffsetMinutes through', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => googlePlace() });
  try {
    const venue = await fetchVenueFromGoogle('place-LA', 5);
    assert.ok(venue, 'venue should shape from a healthy Google response');
    assert.equal(venue.utcOffsetMinutes, -420,
      'the app crowd card scored an LA bar on the viewer clock because this was dropped');
    assert.ok(venueLocalNow(venue.utcOffsetMinutes, new Date('2026-08-15T02:30:00Z')),
      'venueLocalNow(venue.utcOffsetMinutes) must be non-null so line ~203 actually fires');
  } finally {
    global.fetch = realFetch;
  }
});

test('a UTC-offset of exactly 0 is a real clock, not treated as absent', () => {
  // London in winter (offset 0) must still resolve to a venue clock — the bug
  // would be an `if (offset)` truthiness check dropping the zero.
  const shape = toVenueShape(googlePlace({ utcOffsetMinutes: 0 }), null);
  assert.equal(shape.utcOffsetMinutes, 0);
  const clock = venueLocalNow(shape.utcOffsetMinutes, new Date('2026-08-15T09:15:00Z'));
  assert.ok(clock, 'offset 0 is UTC, a valid clock');
  assert.equal(clock.hour, 9);
});

test('a missing offset shapes to null so the caller falls back to its own clock', () => {
  const place = googlePlace();
  delete place.utcOffsetMinutes;
  const shape = toVenueShape(place, 3);
  assert.equal(shape.utcOffsetMinutes, null);
  assert.equal(venueLocalNow(shape.utcOffsetMinutes), null, 'null offset => no venue clock, fall back');
});

test('a fractional-hour offset (India +330) still yields a coherent venue clock', () => {
  const shape = toVenueShape(googlePlace({ utcOffsetMinutes: 330 }), null);
  assert.equal(shape.utcOffsetMinutes, 330);
  // 20:00 UTC + 5:30 = 01:30 IST -> hour 1, next day.
  const clock = venueLocalNow(shape.utcOffsetMinutes, new Date('2026-08-15T20:00:00Z'));
  assert.equal(clock.hour, 1);
});

// --- 1b. "today's hours" use the venue's own weekday, not the viewer's ------
// Fixing the offset drop exposed this: the card is scored on the venue's day,
// so the displayed hours must be the venue's day too, or they disagree by a day
// for a venue west of the viewer across midnight.

function placeWithPerDayHours(offset) {
  // open hour is 8 + weekday, so each day's window is distinguishable.
  const periods = Array.from({ length: 7 }, (_, d) => ({
    open: { day: d, hour: 8 + d }, close: { day: d, hour: 22 },
  }));
  return googlePlace({ utcOffsetMinutes: offset, currentOpeningHours: { openNow: true, periods } });
}

test('toVenueShape picks today\'s window by the venue clock, ignoring a wrong clientDay', () => {
  const offset = -420;
  const venueDay = venueLocalNow(offset).day;
  const wrongClientDay = (venueDay + 1) % 7; // a day that would give a different window
  const shape = toVenueShape(placeWithPerDayHours(offset), wrongClientDay);
  assert.equal(shape.openHour, 8 + venueDay,
    'hoursToday must follow the venue day, not the clientDay argument');
  assert.notEqual(shape.openHour, 8 + wrongClientDay);
});

test('fetchVenueFromGoogle picks today\'s window by the venue clock too', async () => {
  const offset = -420;
  const venueDay = venueLocalNow(offset).day;
  const wrongClientDay = (venueDay + 1) % 7;
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => placeWithPerDayHours(offset) });
  try {
    const venue = await fetchVenueFromGoogle('place-LA', wrongClientDay);
    assert.equal(venue.openHour, 8 + venueDay,
      'the app card scored on the venue day must show the venue day hours');
  } finally {
    global.fetch = realFetch;
  }
});

// --- 2. no fabricated per-venue variance in the displayed score -------------

test('calculateCrowdScore no longer returns a hash-derived variance factor', () => {
  const venue = { place_id: 'abc', types: ['restaurant'], rating: 4.2, user_ratings_total: 300, price_level: 2 };
  const r = calculateCrowdScore(venue, null, new Date(2026, 7, 14, 19, 0, 0));
  assert.equal('variance' in r.factors, false, 'the fabricated ±5 hash nudge must be gone');
  assert.ok(Number.isFinite(r.score) && r.score >= 0 && r.score <= 100);
});

test('two venues identical but for place_id now score identically', () => {
  // With the hash-variance removed, the ONLY thing differing here is the id,
  // which is not a real signal, so the scores must match.
  const ts = new Date(2026, 7, 14, 20, 0, 0);
  const base = { types: ['bar'], rating: 4.3, user_ratings_total: 1200, price_level: 2 };
  const a = calculateCrowdScore({ ...base, place_id: 'aaaaaaaa' }, null, ts);
  const b = calculateCrowdScore({ ...base, place_id: 'zzzzzzzz-different' }, null, ts);
  assert.equal(a.score, b.score, 'identical venues must not diverge on a hash of their id');
});
