// Run: node --test  (from backend/)
//
// SECURITY-AUDIT-injection-idor.md (LOW/INFO): routes/ai.js built the Google
// Place Details URL by interpolating `toolInput.place_id` raw into the URL
// path, unlike routes/crowd.js which wraps the same value in
// encodeURIComponent. The Birdie tool handler at that call site is not unit
// testable in isolation (it runs inside a Gemini tool-dispatch loop behind a
// paid Places budget gate), so this is a source-scan that pins the fix: the
// outbound Places URL in ai.js must percent-encode the id, and no raw
// `${...place_id...}` interpolation may reach a places.googleapis.com URL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');

test('ai.js encodes place_id into the outbound Places Details URL', () => {
  // The fixed call site is present, exactly as written.
  assert.ok(
    aiSrc.includes('https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}'),
    'ai.js no longer encodes placeId in the Places Details URL'
  );
});

test('no raw ${placeId}/${place_id} interpolation survives in an ai.js Places URL', () => {
  // Match any `.../v1/places/${ ... }` template segment and assert the encoder
  // is inside it whenever a place-id variable is. This catches a regression
  // where someone drops the encodeURIComponent back out.
  const urlSegments = aiSrc.match(/v1\/places\/\$\{[^}]*\}/g) || [];
  assert.ok(urlSegments.length > 0, 'expected at least one Places path template in ai.js');
  for (const seg of urlSegments) {
    if (/place_?id/i.test(seg)) {
      assert.ok(
        seg.includes('encodeURIComponent'),
        `raw place id interpolated into a Places URL path: ${seg}`
      );
    }
  }
});
