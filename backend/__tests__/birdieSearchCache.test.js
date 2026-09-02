// Run: node --test  (from backend/)
//
// BIRDIE'S VENUE SEARCH IS CACHED, AND THE CACHE IS CHECKED BEFORE THE BILL.
//
// routes/ai.js was the one Text Search caller with no cache in front of it:
// the tool loop re-bought the same $35-per-thousand search every time the model
// asked, with only the per-user rate limiter in the way, and the call site's
// own comment admitted a user could steer the model into calling it repeatedly
// (2026-09-01). The handler runs inside a Gemini tool-dispatch loop behind a
// paid budget gate and is not unit testable in isolation, so, like
// aiPlaceIdEncode.test.js, this pins the fix by reading the source. Order is
// the contract: a cache hit must be served BEFORE allowPlacesSearch spends a
// unit of anyone's allowance, only a real answer may be stored, and the
// in-flight coalescing map must be cleared on every exit path.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');

function searchVenuesCase() {
  const start = src.indexOf("case 'search_venues': {");
  const end = src.indexOf("case 'get_crowd_prediction': {", start);
  assert.ok(start > 0 && end > start, 'the search_venues case must exist ahead of get_crowd_prediction');
  return src.slice(start, end);
}

test('the cache is consulted before the Places budget gate', () => {
  const body = searchVenuesCase();
  const hit = body.indexOf('birdieSearchGet(searchKey)');
  const gate = body.indexOf('allowPlacesSearch(userId)');
  assert.ok(hit > 0, 'the search case must read the cache');
  assert.ok(gate > 0, 'the budget gate must still be present');
  assert.ok(hit < gate, 'a cache hit must be served before the budget gate spends an allowance unit');
});

test('identical in-flight misses coalesce into one upstream call', () => {
  const body = searchVenuesCase();
  const inflightRead = body.indexOf('birdieSearchInflight.get(searchKey)');
  const gate = body.indexOf('allowPlacesSearch(userId)');
  assert.ok(inflightRead > 0 && inflightRead < gate, 'an in-flight duplicate must be joined before the budget gate too');
  assert.ok(body.includes('birdieSearchInflight.set(searchKey, work)'));
  assert.ok(/finally\s*\{[^}]*birdieSearchInflight\.delete\(searchKey\)/.test(body), 'the in-flight entry must be cleared in a finally so an error cannot pin it');
});

test('only a real answer is cached, so an upstream failure cannot pin itself', () => {
  const body = searchVenuesCase();
  assert.ok(
    body.includes('if (resp.ok && Array.isArray(data.places)) birdieSearchSet(searchKey, venues);'),
    'the store must be guarded on resp.ok and a real places array'
  );
});

test('the key normalises the query and rounds the location to about a kilometre', () => {
  assert.ok(src.includes("const q = String(query || '').trim().toLowerCase().replace(/\\s+/g, ' ');"));
  assert.ok(src.includes('lat.toFixed(2)') && src.includes('lng.toFixed(2)'), 'two decimals of latitude and longitude');
});

test('the TTL and eviction match the venue search route it mirrors', () => {
  assert.ok(src.includes('const BIRDIE_SEARCH_TTL_MS = 5 * 60 * 1000;'), 'five minutes, the same TTL as routes/venueSearch.js');
  assert.ok(src.includes('BIRDIE_SEARCH_LOW_WATER'), 'eviction to a low-water mark, not to the exact ceiling');
  // Delete-then-set so a refreshed key moves to the end of insertion order and
  // oldest-first eviction cannot evict the hottest query.
  assert.ok(/birdieSearchCache\.delete\(key\);\s*birdieSearchCache\.set\(key/.test(src));
});
