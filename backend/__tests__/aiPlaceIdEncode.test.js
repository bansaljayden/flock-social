// Run: node --test  (from backend/)
//
// SECURITY-AUDIT-injection-idor.md (LOW/INFO): routes/ai.js built the Google
// Place Details URL by interpolating `toolInput.place_id` raw into the URL
// path, unlike routes/crowd.js which wraps the same value in
// encodeURIComponent. The Birdie tool handler at that call site is not unit
// testable in isolation (it runs inside a Gemini tool-dispatch loop behind a
// paid Places budget gate), so this is a source-scan that pins the fix: the
// outbound Places URL must percent-encode the id, and no raw
// `${...place_id...}` interpolation may reach a places.googleapis.com URL.
//
// The crowd tool no longer builds that URL itself: it reads the card's cached
// payload through services/placeDetailsCache.js, which builds it. So the scan
// covers both files, and the first test pins that ai.js goes through the cache
// rather than growing a Place Details fetch of its own again, and that the
// cache is where the encoding now lives.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
const cacheSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'placeDetailsCache.js'), 'utf8');

test('ai.js reads Place Details through the shared cache, which encodes the id', () => {
  assert.ok(aiSrc.includes('await fetchPlaceDetails(placeId)'),
    'the Birdie crowd tool no longer reads the shared Place Details cache');
  assert.ok(!/places\.googleapis\.com\/v1\/places\/\$\{/.test(aiSrc),
    'ai.js builds its own Place Details URL again, outside the shared cache and its encoding');
  assert.ok(
    cacheSrc.includes('https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}'),
    'services/placeDetailsCache.js no longer encodes placeId in the Places Details URL'
  );
});

test('no raw ${placeId}/${place_id} interpolation survives in a Places URL Birdie reaches', () => {
  // Match any `.../v1/places/${ ... }` template segment and assert the encoder
  // is inside it whenever a place-id variable is. This catches a regression
  // where someone drops the encodeURIComponent back out.
  const urlSegments = [aiSrc, cacheSrc].flatMap((src) => src.match(/v1\/places\/\$\{[^}]*\}/g) || []);
  assert.ok(urlSegments.length > 0, 'expected at least one Places path template across ai.js and the details cache');
  for (const seg of urlSegments) {
    if (/place_?id/i.test(seg)) {
      assert.ok(
        seg.includes('encodeURIComponent'),
        `raw place id interpolated into a Places URL path: ${seg}`
      );
    }
  }
});
