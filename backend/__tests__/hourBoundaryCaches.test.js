// A cached crowd answer never outlives the next turn of the hour, nor, when it
// was made in the first minutes after one, the minute that hour's live
// readings are in by (utils/liveReadingsClock.js). Pinned for the three caches
// that hold one: the card and alternatives cache (routes/crowd.js), the badge
// (routes/badge.js, with the max-age it is served with) and the predictor's
// recent-deviation cache (services/mlPredictor.js), which holds the readings
// the nowcast reads. The neighbour search, which holds no crowd number, keeps
// its plain TTL.
// No database, no network. Run: node --test  (from backend/)

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-hour-boundary-caches';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const at = (h, m, s = 0) => Date.UTC(2026, 10, 23, h, m, s);
const realNow = Date.now;
function atTime(ms, fn) {
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = realNow; }
}
// The same around an async call: the clock stays moved until it settles.
async function atTimeAsync(ms, fn) {
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = realNow; }
}

test('the card and the alternatives end at the boundary; the neighbour search keeps its TTL', () => {
  const crowd = require('../routes/crowd').__test;
  crowd.clearCache();
  atTime(at(11, 0, 30), () => {
    crowd.seedCache('full:PLACE_A:11:1', { card: 1 }, { crowdNumbers: true });
    crowd.seedCache('alt:PLACE_A:11:1', { alts: 1 }, { crowdNumbers: true });
    crowd.seedCache('altsearch:PLACE_A', { search: 1 });
  });
  atTime(at(11, 2, 59), () => {
    assert.deepEqual(crowd.getCached('full:PLACE_A:11:1'), { card: 1 });
    assert.deepEqual(crowd.getCached('alt:PLACE_A:11:1'), { alts: 1 });
  });
  atTime(at(11, 3, 0), () => {
    assert.equal(crowd.getCached('full:PLACE_A:11:1'), null, 'made before the readings were in: gone once they are');
    assert.equal(crowd.getCached('alt:PLACE_A:11:1'), null);
    assert.deepEqual(crowd.getCached('altsearch:PLACE_A'), { search: 1 }, 'no crowd number, no boundary');
  });
  atTime(at(11, 10, 29), () => assert.deepEqual(crowd.getCached('altsearch:PLACE_A'), { search: 1 }));
  atTime(at(11, 10, 30), () => assert.equal(crowd.getCached('altsearch:PLACE_A'), null, 'its own ten minutes'));
  // Mid-hour, the TTL as before.
  atTime(at(11, 20), () => crowd.seedCache('full:PLACE_B:11:1', { card: 2 }, { crowdNumbers: true }));
  atTime(at(11, 29, 59), () => assert.deepEqual(crowd.getCached('full:PLACE_B:11:1'), { card: 2 }));
  atTime(at(11, 30), () => assert.equal(crowd.getCached('full:PLACE_B:11:1'), null));
  // Started at 12:02:59 and stored at 12:03:01: made before the readings
  // were in, so it ends at 12:03, not ten minutes after it was stored.
  atTime(at(12, 3, 1), () => {
    crowd.seedCache('full:PLACE_C:12:1', { card: 3 }, { crowdNumbers: true, madeAt: at(12, 2, 59) });
    assert.equal(crowd.getCached('full:PLACE_C:12:1'), null);
  });
  crowd.clearCache();
});

test('a badge ends at the next turn of the hour, and is served with the time it has left', () => {
  const badge = require('../routes/badge').__test;
  badge.resetBadgeBudget();
  atTime(at(11, 58), () => {
    badge.setBadge('PLACE_BADGE_HOUR', '<svg>busy</svg>');
    assert.equal(badge.badgeCacheControl('PLACE_BADGE_HOUR'), 'public, max-age=120', 'never past 12:00');
  });
  atTime(at(11, 59, 59), () => assert.equal(badge.getBadge('PLACE_BADGE_HOUR'), '<svg>busy</svg>'));
  atTime(at(12, 0, 0), () => assert.equal(badge.getBadge('PLACE_BADGE_HOUR'), null, "the last hour's number is not today's"));
  atTime(at(12, 0, 30), () => {
    badge.setBadge('PLACE_BADGE_HOUR', '<svg>quiet</svg>');
    assert.equal(badge.badgeCacheControl('PLACE_BADGE_HOUR'), 'public, max-age=150', 'until the readings are in at 12:03');
  });
  atTime(at(12, 10), () => {
    badge.setBadge('PLACE_BADGE_HOUR', '<svg>steady</svg>');
    assert.equal(badge.badgeCacheControl('PLACE_BADGE_HOUR'), 'public, max-age=900', 'mid-hour, the fifteen minutes as before');
  });
  atTime(at(12, 20), () => assert.equal(badge.badgeCacheControl('PLACE_BADGE_HOUR'), 'public, max-age=300', 'a cached copy is served with what it has left'));
  assert.equal(badge.badgeCacheControl('PLACE_NEVER_CACHED'), 'public, max-age=0');
  // Started before 13:03 and stored after it: it ends at 13:03.
  atTime(at(13, 3, 1), () => {
    badge.setBadge('PLACE_BADGE_LATE', '<svg>late</svg>', at(13, 2, 59));
    assert.equal(badge.getBadge('PLACE_BADGE_LATE'), null);
  });
  badge.resetBadgeBudget();
});

test("the predictor's recent readings are read again after the turn of the hour", async () => {
  const pool = require('../config/database');
  const realQuery = pool.query;
  let reads = 0;
  pool.query = async (text) => {
    if (/FROM ml_venue_recent_deviation/.test(String(text))) {
      reads++;
      return { rows: [{ offset_pct: 4, n_readings: 6, updated_at: new Date(Date.now()), recent_readings: [], offset_readings: [] }] };
    }
    return { rows: [] };
  };
  const I = require('../services/mlPredictor')._internals;
  try {
    I.__resetVenueLookupCaches();
    await atTimeAsync(at(11, 57), () => I.recentDeviationEntry('ChIJhourboundary_dev'));
    await atTimeAsync(at(11, 59, 59), () => I.recentDeviationEntry('ChIJhourboundary_dev'));
    assert.equal(reads, 1, 'inside the hour, the cached row');
    await atTimeAsync(at(12, 0, 1), () => I.recentDeviationEntry('ChIJhourboundary_dev'));
    assert.equal(reads, 2, 'read at :57, it no longer answers for the next hour');
    await atTimeAsync(at(12, 2), () => I.recentDeviationEntry('ChIJhourboundary_dev'));
    assert.equal(reads, 2);
    await atTimeAsync(at(12, 3), () => I.recentDeviationEntry('ChIJhourboundary_dev'));
    assert.equal(reads, 3, 'read before the readings were in, read again once they are');
    await atTimeAsync(at(12, 7, 59), () => I.recentDeviationEntry('ChIJhourboundary_dev'));
    assert.equal(reads, 3, 'then its five minutes as before');
    await atTimeAsync(at(12, 8), () => I.recentDeviationEntry('ChIJhourboundary_dev'));
    assert.equal(reads, 4);
    // A read sent at 13:02:59 and answered at 13:03:01 is a read from before
    // 13:03: the next request reads again.
    const slow = pool.query;
    pool.query = async (text) => { Date.now = () => at(13, 3, 1); return slow(text); };
    await atTimeAsync(at(13, 2, 59), () => I.recentDeviationEntry('ChIJhourboundary_dev'));
    pool.query = slow;
    assert.equal(reads, 5);
    await atTimeAsync(at(13, 3, 2), () => I.recentDeviationEntry('ChIJhourboundary_dev'));
    assert.equal(reads, 6);
  } finally {
    pool.query = realQuery;
    I.__resetVenueLookupCaches();
  }
});
